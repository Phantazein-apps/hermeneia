package main

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"

	_ "github.com/mattn/go-sqlite3"
	"go.mau.fi/whatsmeow"
	"go.mau.fi/whatsmeow/proto/waCompanionReg"
	"go.mau.fi/whatsmeow/proto/waE2E"
	"go.mau.fi/whatsmeow/store"
	"go.mau.fi/whatsmeow/store/sqlstore"
	"go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/types/events"
	waLog "go.mau.fi/whatsmeow/util/log"
	"google.golang.org/protobuf/proto"
)

var client *whatsmeow.Client
var dataDir string

// mediaCache stores raw protobuf messages for later download, keyed by message ID.
// Entries are evicted after 24 hours to avoid unbounded growth.
var (
	mediaCache   = make(map[string]*waE2E.Message)
	mediaCacheMu sync.Mutex
)

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintf(os.Stderr, "Usage: hermeneia-bridge <data-dir>\n")
		os.Exit(1)
	}
	dataDir = os.Args[1]

	// Ensure data directory exists
	os.MkdirAll(dataDir, 0755)

	// Initialize whatsmeow SQLite store
	dbPath := filepath.Join(dataDir, "whatsmeow.db")
	// Use noop logger — whatsmeow's default logger writes to stdout
	// which would corrupt our JSON protocol. Errors go through our logf().
	logger := waLog.Noop

	container, err := sqlstore.New(
		context.Background(),
		"sqlite3",
		fmt.Sprintf("file:%s?_foreign_keys=on", dbPath),
		logger,
	)
	if err != nil {
		logf("Failed to init store: %v", err)
		os.Exit(1)
	}

	// Set device name to "Claude" — shown in WhatsApp > Linked Devices
	store.DeviceProps.Os = proto.String("Claude")
	store.DeviceProps.PlatformType = waCompanionReg.DeviceProps_DESKTOP.Enum()
	store.DeviceProps.RequireFullSync = proto.Bool(true)

	// Request deep history sync
	store.DeviceProps.HistorySyncConfig.FullSyncDaysLimit = proto.Uint32(365 * 3)
	store.DeviceProps.HistorySyncConfig.FullSyncSizeMbLimit = proto.Uint32(5120)
	store.DeviceProps.HistorySyncConfig.RecentSyncDaysLimit = proto.Uint32(365)
	store.DeviceProps.HistorySyncConfig.StorageQuotaMb = proto.Uint32(10240)
	store.DeviceProps.HistorySyncConfig.InitialSyncMaxMessagesPerChat = proto.Uint32(1000)

	// Get or create device
	device, err := container.GetFirstDevice(context.Background())
	if err != nil {
		logf("Failed to get device: %v", err)
		os.Exit(1)
	}

	client = whatsmeow.NewClient(device, logger)
	client.EnableAutoReconnect = true
	client.AutoTrustIdentity = true

	// Register event handler
	client.AddEventHandler(handleEvent)

	// Connect
	if client.Store.ID == nil {
		// First time — need QR code
		logf("No stored session, starting QR auth...")
		qrChan, err := client.GetQRChannel(context.Background())
		if err != nil {
			logf("Failed to get QR channel: %v", err)
			os.Exit(1)
		}

		err = client.Connect()
		if err != nil {
			logf("Failed to connect: %v", err)
			os.Exit(1)
		}

		// Forward QR codes to Node.js
		for evt := range qrChan {
			switch evt.Event {
			case "code":
				emit(Event{Type: "qr", Data: evt.Code})
			case "success":
				logf("QR auth successful")
			case "timeout":
				logf("QR code timed out")
				emit(Event{Type: "error", Message: "QR code timed out — restart to try again"})
			}
		}
	} else {
		// Existing session — just connect
		logf("Reconnecting with stored session...")
		err = client.Connect()
		if err != nil {
			logf("Failed to connect: %v", err)
			os.Exit(1)
		}
	}

	// Start stdin command reader
	go readCommands()

	// Wait for shutdown
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
	<-sigCh

	logf("Shutting down...")
	client.Disconnect()
}

// ── Event handler ─────────────────────────────────────────────────

func handleEvent(rawEvt interface{}) {
	switch evt := rawEvt.(type) {

	case *events.Connected:
		logf("Connected to WhatsApp!")
		emit(Event{Type: "connected"})

		// Send all contacts after a brief delay (let history sync start)
		go func() {
			time.Sleep(5 * time.Second)
			sendAllContacts()
		}()

	case *events.LoggedOut:
		logf("Logged out")
		emit(Event{Type: "logged_out"})

	case *events.PushName:
		// Another user's push name changed
		logf("Push name update: %s -> %s", evt.JID, evt.NewPushName)
		emitContact(evt.JID, evt.NewPushName, "")

	case *events.Contact:
		// Contact list entry modified
		name := ""
		if evt.Action != nil {
			name = evt.Action.GetFullName()
			if name == "" {
				name = evt.Action.GetFirstName()
			}
		}
		if name != "" {
			logf("Contact update: %s -> %s", evt.JID, name)
			emitContact(evt.JID, name, "")
		}

	case *events.Message:
		handleMessage(evt)

	case *events.HistorySync:
		handleHistorySync(evt)

	case *events.Disconnected:
		logf("Disconnected, will auto-reconnect")

	case *events.StreamReplaced:
		logf("Stream replaced (another device connected)")
		os.Exit(0)
	}
}

// ── Message handling ──────────────────────────────────────────────

func handleMessage(evt *events.Message) {
	info := evt.Info
	chatJID := info.Chat.String()
	sender := info.Sender.String()
	isFromMe := info.IsFromMe
	timestamp := info.Timestamp.UTC().Format(time.RFC3339)
	messageID := info.ID

	// Extract text
	content := extractText(evt.Message)

	// Extract media type and info
	var mediaType *string
	mt := extractMediaType(evt.Message)
	if mt != "" {
		mediaType = &mt
		// Cache for in-session fast download
		mediaCacheMu.Lock()
		mediaCache[messageID] = evt.Message
		mediaCacheMu.Unlock()
	}
	mediaInfo := extractMediaInfo(evt.Message)

	// Get push name
	pushName := info.PushName

	// Emit contact update if we have a push name
	if pushName != "" && sender != chatJID {
		emitContact(info.Sender, pushName, "")
	}

	emit(Event{
		Type:      "message",
		ID:        messageID,
		ChatJID:   chatJID,
		Sender:    sender,
		Content:   content,
		IsFromMe:  isFromMe,
		Timestamp: timestamp,
		MediaType: mediaType,
		MediaInfo: mediaInfo,
		PushName:  pushName,
	})
}

func extractText(msg *waE2E.Message) string {
	if msg == nil {
		return ""
	}
	if msg.Conversation != nil {
		return *msg.Conversation
	}
	if msg.ExtendedTextMessage != nil && msg.ExtendedTextMessage.Text != nil {
		return *msg.ExtendedTextMessage.Text
	}
	if msg.ImageMessage != nil && msg.ImageMessage.Caption != nil {
		return *msg.ImageMessage.Caption
	}
	if msg.VideoMessage != nil && msg.VideoMessage.Caption != nil {
		return *msg.VideoMessage.Caption
	}
	if msg.DocumentMessage != nil && msg.DocumentMessage.Caption != nil {
		return *msg.DocumentMessage.Caption
	}
	return ""
}

func extractMediaInfo(msg *waE2E.Message) *MediaInfo {
	if msg == nil {
		return nil
	}
	switch {
	case msg.ImageMessage != nil:
		m := msg.ImageMessage
		return &MediaInfo{
			MediaType: "image", Mimetype: m.GetMimetype(),
			MediaKey: m.GetMediaKey(), DirectPath: m.GetDirectPath(),
			URL: m.GetURL(), FileEncSHA256: m.GetFileEncSHA256(),
			FileSHA256: m.GetFileSHA256(), FileLength: m.GetFileLength(),
		}
	case msg.VideoMessage != nil:
		m := msg.VideoMessage
		return &MediaInfo{
			MediaType: "video", Mimetype: m.GetMimetype(),
			MediaKey: m.GetMediaKey(), DirectPath: m.GetDirectPath(),
			URL: m.GetURL(), FileEncSHA256: m.GetFileEncSHA256(),
			FileSHA256: m.GetFileSHA256(), FileLength: m.GetFileLength(),
		}
	case msg.AudioMessage != nil:
		m := msg.AudioMessage
		return &MediaInfo{
			MediaType: "audio", Mimetype: m.GetMimetype(),
			MediaKey: m.GetMediaKey(), DirectPath: m.GetDirectPath(),
			URL: m.GetURL(), FileEncSHA256: m.GetFileEncSHA256(),
			FileSHA256: m.GetFileSHA256(), FileLength: m.GetFileLength(),
		}
	case msg.DocumentMessage != nil:
		m := msg.DocumentMessage
		return &MediaInfo{
			MediaType: "document", Mimetype: m.GetMimetype(),
			MediaKey: m.GetMediaKey(), DirectPath: m.GetDirectPath(),
			URL: m.GetURL(), FileEncSHA256: m.GetFileEncSHA256(),
			FileSHA256: m.GetFileSHA256(), FileLength: m.GetFileLength(),
			Filename: m.GetFileName(),
		}
	case msg.StickerMessage != nil:
		m := msg.StickerMessage
		return &MediaInfo{
			MediaType: "sticker", Mimetype: m.GetMimetype(),
			MediaKey: m.GetMediaKey(), DirectPath: m.GetDirectPath(),
			URL: m.GetURL(), FileEncSHA256: m.GetFileEncSHA256(),
			FileSHA256: m.GetFileSHA256(), FileLength: m.GetFileLength(),
		}
	}
	return nil
}

func extractMediaType(msg *waE2E.Message) string {
	if msg == nil {
		return ""
	}
	if msg.ImageMessage != nil {
		return "image"
	}
	if msg.VideoMessage != nil {
		return "video"
	}
	if msg.AudioMessage != nil {
		return "audio"
	}
	if msg.DocumentMessage != nil {
		return "document"
	}
	return ""
}

// ── History sync ──────────────────────────────────────────────────

func handleHistorySync(evt *events.HistorySync) {
	data := evt.Data
	logf("History sync: type=%d, conversations=%d, pushnames=%d",
		data.GetSyncType(), len(data.GetConversations()), len(data.GetPushnames()))

	// Process push names (this is what Baileys was missing!)
	for _, pn := range data.GetPushnames() {
		if pn.GetID() != "" && pn.GetPushname() != "" {
			jid, _ := types.ParseJID(pn.GetID())
			emitContact(jid, pn.GetPushname(), "")
		}
	}

	// Process conversations
	for _, conv := range data.GetConversations() {
		chatJID := conv.GetID()
		chatName := conv.GetName()

		// Emit chat
		var ts string
		if conv.GetConversationTimestamp() > 0 {
			ts = time.Unix(int64(conv.GetConversationTimestamp()), 0).UTC().Format(time.RFC3339)
		} else {
			ts = time.Now().UTC().Format(time.RFC3339)
		}

		unread := int(conv.GetUnreadCount())
		markedUnread := conv.GetMarkedAsUnread()

		emit(Event{
			Type:            "chat",
			JID:             chatJID,
			Name:            chatName,
			LastMessageTime: ts,
			UnreadCount:     &unread,
			MarkedAsUnread:  &markedUnread,
		})

		// Process messages in this conversation
		for _, hm := range conv.GetMessages() {
			msg := hm.GetMessage()
			if msg == nil || msg.GetMessage() == nil {
				continue
			}

			key := msg.GetKey()
			chatJ := chatJID
			sender := chatJ
			if key.GetParticipant() != "" {
				sender = key.GetParticipant()
			} else if key.GetRemoteJID() != "" {
				sender = key.GetRemoteJID()
			}

			isFromMe := key.GetFromMe()
			timestamp := time.Unix(int64(msg.GetMessageTimestamp()), 0).UTC().Format(time.RFC3339)
			messageID := key.GetID()
			content := extractText(msg.GetMessage())
			var mediaType *string
			mt := extractMediaType(msg.GetMessage())
			if mt != "" {
				mediaType = &mt
			}
			mInfo := extractMediaInfo(msg.GetMessage())

			pushName := msg.GetPushName()
			if pushName != "" && sender != chatJ {
				senderJID, err := types.ParseJID(sender)
				if err == nil {
					emitContact(senderJID, pushName, "")
				}
			}

			if content == "" && mediaType == nil {
				continue
			}

			emit(Event{
				Type:      "message",
				ID:        messageID,
				ChatJID:   chatJ,
				Sender:    sender,
				Content:   content,
				IsFromMe:  isFromMe,
				Timestamp: timestamp,
				MediaType: mediaType,
				MediaInfo: mInfo,
				PushName:  pushName,
			})
		}
	}
}

// ── Contact resolution ────────────────────────────────────────────

func emitContact(jid types.JID, pushName string, verifiedName string) {
	// Also look up LID <-> phone mapping
	var phoneJID string
	var lid string

	if jid.Server == "lid" {
		lid = jid.String()
		// Try to resolve LID to phone number
		pn, err := client.Store.LIDs.GetPNForLID(context.Background(), jid)
		if err == nil && !pn.IsEmpty() {
			phoneJID = pn.String()
		}
	} else if jid.Server == types.DefaultUserServer {
		phoneJID = jid.String()
		// Try to resolve phone to LID
		l, err := client.Store.LIDs.GetLIDForPN(context.Background(), jid)
		if err == nil && !l.IsEmpty() {
			lid = l.String()
		}
	}

	var vn *string
	if verifiedName != "" {
		vn = &verifiedName
	}

	emit(Event{
		Type:         "contact",
		ID:           jid.String(),
		PhoneJID:     phoneJID,
		LID:          lid,
		Notify:       pushName,
		VerifiedName: vn,
	})
}

func sendAllContacts() {
	contacts, err := client.Store.Contacts.GetAllContacts(context.Background())
	if err != nil {
		logf("Failed to get contacts: %v", err)
		return
	}

	logf("Sending %d contacts to Node.js", len(contacts))

	for jid, info := range contacts {
		name := info.PushName
		if name == "" {
			name = info.FullName
		}
		if name == "" {
			name = info.BusinessName
		}

		var phoneJID string
		var lid string

		if jid.Server == "lid" {
			lid = jid.String()
			pn, err := client.Store.LIDs.GetPNForLID(context.Background(), jid)
			if err == nil && !pn.IsEmpty() {
				phoneJID = pn.String()
			}
		} else if jid.Server == types.DefaultUserServer {
			phoneJID = jid.String()
			l, err := client.Store.LIDs.GetLIDForPN(context.Background(), jid)
			if err == nil && !l.IsEmpty() {
				lid = l.String()
			}
		}

		emit(Event{
			Type:     "contact",
			ID:       jid.String(),
			PhoneJID: phoneJID,
			LID:      lid,
			Notify:   name,
			Name:     info.FullName,
		})
	}

	emit(Event{Type: "contacts_ready", Count: len(contacts)})
}

// ── Command handling (stdin) ──────────────────────────────────────

func readCommands() {
	scanner := bufio.NewScanner(os.Stdin)
	// Increase buffer size for large commands (file paths, etc.)
	scanner.Buffer(make([]byte, 1024*1024), 1024*1024)

	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}

		var cmd Command
		if err := json.Unmarshal([]byte(line), &cmd); err != nil {
			logf("Invalid command: %v", err)
			continue
		}

		switch cmd.Cmd {
		case "send_message":
			go handleSendMessage(cmd)
		case "send_file":
			go handleSendFile(cmd)
		case "download_media":
			go handleDownloadMedia(cmd)
		case "get_contacts":
			go func() {
				sendAllContacts()
				emit(Event{Type: "response", ReqID: cmd.ID, Success: true})
			}()
		case "stop":
			logf("Stop command received")
			client.Disconnect()
			os.Exit(0)
		default:
			emit(Event{Type: "response", ReqID: cmd.ID, Success: false, Message: "unknown command: " + cmd.Cmd})
		}
	}
}

func handleSendMessage(cmd Command) {
	if client == nil {
		emit(Event{Type: "response", ReqID: cmd.ID, Success: false, Message: "not connected"})
		return
	}

	jid := normalizeJID(cmd.Recipient)
	targetJID, err := types.ParseJID(jid)
	if err != nil {
		emit(Event{Type: "response", ReqID: cmd.ID, Success: false, Message: fmt.Sprintf("invalid JID: %v", err)})
		return
	}

	msg := &waE2E.Message{
		Conversation: proto.String(cmd.Text),
	}

	_, err = client.SendMessage(context.Background(), targetJID, msg)
	if err != nil {
		emit(Event{Type: "response", ReqID: cmd.ID, Success: false, Message: fmt.Sprintf("send failed: %v", err)})
		return
	}

	emit(Event{Type: "response", ReqID: cmd.ID, Success: true, Message: "sent"})
}

func handleSendFile(cmd Command) {
	if client == nil {
		emit(Event{Type: "response", ReqID: cmd.ID, Success: false, Message: "not connected"})
		return
	}

	jid := normalizeJID(cmd.Recipient)
	targetJID, err := types.ParseJID(jid)
	if err != nil {
		emit(Event{Type: "response", ReqID: cmd.ID, Success: false, Message: fmt.Sprintf("invalid JID: %v", err)})
		return
	}

	data, err := os.ReadFile(cmd.Path)
	if err != nil {
		emit(Event{Type: "response", ReqID: cmd.ID, Success: false, Message: fmt.Sprintf("read file failed: %v", err)})
		return
	}

	ext := strings.ToLower(filepath.Ext(cmd.Path))
	var msg *waE2E.Message

	switch ext {
	case ".jpg", ".jpeg", ".png", ".gif", ".webp":
		uploaded, err := client.Upload(context.Background(), data, whatsmeow.MediaImage)
		if err != nil {
			emit(Event{Type: "response", ReqID: cmd.ID, Success: false, Message: fmt.Sprintf("upload failed: %v", err)})
			return
		}
		msg = &waE2E.Message{
			ImageMessage: &waE2E.ImageMessage{
				URL:           &uploaded.URL,
				DirectPath:    &uploaded.DirectPath,
				MediaKey:      uploaded.MediaKey,
				FileEncSHA256: uploaded.FileEncSHA256,
				FileSHA256:    uploaded.FileSHA256,
				FileLength:    proto.Uint64(uint64(len(data))),
				Mimetype:      proto.String("image/jpeg"),
				Caption:       nilIfEmpty(cmd.Caption),
			},
		}
	case ".mp4", ".avi", ".mov":
		uploaded, err := client.Upload(context.Background(), data, whatsmeow.MediaVideo)
		if err != nil {
			emit(Event{Type: "response", ReqID: cmd.ID, Success: false, Message: fmt.Sprintf("upload failed: %v", err)})
			return
		}
		msg = &waE2E.Message{
			VideoMessage: &waE2E.VideoMessage{
				URL:           &uploaded.URL,
				DirectPath:    &uploaded.DirectPath,
				MediaKey:      uploaded.MediaKey,
				FileEncSHA256: uploaded.FileEncSHA256,
				FileSHA256:    uploaded.FileSHA256,
				FileLength:    proto.Uint64(uint64(len(data))),
				Mimetype:      proto.String("video/mp4"),
				Caption:       nilIfEmpty(cmd.Caption),
			},
		}
	case ".ogg":
		uploaded, err := client.Upload(context.Background(), data, whatsmeow.MediaAudio)
		if err != nil {
			emit(Event{Type: "response", ReqID: cmd.ID, Success: false, Message: fmt.Sprintf("upload failed: %v", err)})
			return
		}
		msg = &waE2E.Message{
			AudioMessage: &waE2E.AudioMessage{
				URL:           &uploaded.URL,
				DirectPath:    &uploaded.DirectPath,
				MediaKey:      uploaded.MediaKey,
				FileEncSHA256: uploaded.FileEncSHA256,
				FileSHA256:    uploaded.FileSHA256,
				FileLength:    proto.Uint64(uint64(len(data))),
				Mimetype:      proto.String("audio/ogg; codecs=opus"),
				PTT:           proto.Bool(true),
			},
		}
	default:
		uploaded, err := client.Upload(context.Background(), data, whatsmeow.MediaDocument)
		if err != nil {
			emit(Event{Type: "response", ReqID: cmd.ID, Success: false, Message: fmt.Sprintf("upload failed: %v", err)})
			return
		}
		fileName := filepath.Base(cmd.Path)
		msg = &waE2E.Message{
			DocumentMessage: &waE2E.DocumentMessage{
				URL:           &uploaded.URL,
				DirectPath:    &uploaded.DirectPath,
				MediaKey:      uploaded.MediaKey,
				FileEncSHA256: uploaded.FileEncSHA256,
				FileSHA256:    uploaded.FileSHA256,
				FileLength:    proto.Uint64(uint64(len(data))),
				Mimetype:      proto.String("application/octet-stream"),
				FileName:      &fileName,
				Caption:       nilIfEmpty(cmd.Caption),
			},
		}
	}

	_, err = client.SendMessage(context.Background(), targetJID, msg)
	if err != nil {
		emit(Event{Type: "response", ReqID: cmd.ID, Success: false, Message: fmt.Sprintf("send failed: %v", err)})
		return
	}

	emit(Event{Type: "response", ReqID: cmd.ID, Success: true, Message: "sent"})
}

func handleDownloadMedia(cmd Command) {
	if client == nil {
		emit(Event{Type: "response", ReqID: cmd.ID, Success: false, Message: "not connected"})
		return
	}

	msgID := cmd.MessageID
	if msgID == "" {
		emit(Event{Type: "response", ReqID: cmd.ID, Success: false, Message: "missing message_id"})
		return
	}

	var dl whatsmeow.DownloadableMessage
	var ext string
	var mime string

	// Try in-memory cache first (fastest, works for current session)
	mediaCacheMu.Lock()
	msg, ok := mediaCache[msgID]
	mediaCacheMu.Unlock()

	if ok {
		switch {
		case msg.ImageMessage != nil:
			dl = msg.ImageMessage
			mime = msg.ImageMessage.GetMimetype()
			ext = mimeToExt(mime, ".jpg")
		case msg.VideoMessage != nil:
			dl = msg.VideoMessage
			mime = msg.VideoMessage.GetMimetype()
			ext = mimeToExt(mime, ".mp4")
		case msg.AudioMessage != nil:
			dl = msg.AudioMessage
			mime = msg.AudioMessage.GetMimetype()
			ext = mimeToExt(mime, ".ogg")
		case msg.DocumentMessage != nil:
			dl = msg.DocumentMessage
			mime = msg.DocumentMessage.GetMimetype()
			ext = mimeToExt(mime, ".bin")
			if fn := msg.DocumentMessage.GetFileName(); fn != "" {
				ext = filepath.Ext(fn)
			}
		case msg.StickerMessage != nil:
			dl = msg.StickerMessage
			mime = msg.StickerMessage.GetMimetype()
			ext = mimeToExt(mime, ".webp")
		}
	} else if cmd.MediaInfo != nil {
		// Reconstruct downloadable message from persisted metadata
		mi := cmd.MediaInfo
		mime = mi.Mimetype
		ext = mimeToExt(mime, ".bin")
		if mi.Filename != "" {
			ext = filepath.Ext(mi.Filename)
		}

		switch mi.MediaType {
		case "image":
			dl = &waE2E.ImageMessage{
				MediaKey: mi.MediaKey, DirectPath: &mi.DirectPath,
				URL: &mi.URL, FileEncSHA256: mi.FileEncSHA256,
				FileSHA256: mi.FileSHA256, FileLength: &mi.FileLength,
				Mimetype: &mi.Mimetype,
			}
		case "video":
			dl = &waE2E.VideoMessage{
				MediaKey: mi.MediaKey, DirectPath: &mi.DirectPath,
				URL: &mi.URL, FileEncSHA256: mi.FileEncSHA256,
				FileSHA256: mi.FileSHA256, FileLength: &mi.FileLength,
				Mimetype: &mi.Mimetype,
			}
		case "audio":
			dl = &waE2E.AudioMessage{
				MediaKey: mi.MediaKey, DirectPath: &mi.DirectPath,
				URL: &mi.URL, FileEncSHA256: mi.FileEncSHA256,
				FileSHA256: mi.FileSHA256, FileLength: &mi.FileLength,
				Mimetype: &mi.Mimetype,
			}
		case "document":
			dl = &waE2E.DocumentMessage{
				MediaKey: mi.MediaKey, DirectPath: &mi.DirectPath,
				URL: &mi.URL, FileEncSHA256: mi.FileEncSHA256,
				FileSHA256: mi.FileSHA256, FileLength: &mi.FileLength,
				Mimetype: &mi.Mimetype,
			}
		case "sticker":
			dl = &waE2E.StickerMessage{
				MediaKey: mi.MediaKey, DirectPath: &mi.DirectPath,
				URL: &mi.URL, FileEncSHA256: mi.FileEncSHA256,
				FileSHA256: mi.FileSHA256, FileLength: proto.Uint64(mi.FileLength),
				Mimetype: &mi.Mimetype,
			}
		default:
			emit(Event{Type: "response", ReqID: cmd.ID, Success: false, Message: "unknown media type: " + mi.MediaType})
			return
		}
	} else {
		emit(Event{Type: "response", ReqID: cmd.ID, Success: false, Message: "no media info available for this message"})
		return
	}

	if dl == nil {
		emit(Event{Type: "response", ReqID: cmd.ID, Success: false, Message: "no downloadable media in message"})
		return
	}

	data, err := client.Download(context.Background(), dl)
	if err != nil {
		emit(Event{Type: "response", ReqID: cmd.ID, Success: false, Message: fmt.Sprintf("download failed: %v", err)})
		return
	}

	// Save to disk
	saveDir := cmd.SaveDir
	if saveDir == "" {
		saveDir = filepath.Join(dataDir, "media")
	}
	os.MkdirAll(saveDir, 0755)

	filename := msgID + ext
	savePath := filepath.Join(saveDir, filename)

	if err := os.WriteFile(savePath, data, 0644); err != nil {
		emit(Event{Type: "response", ReqID: cmd.ID, Success: false, Message: fmt.Sprintf("save failed: %v", err)})
		return
	}

	logf("Downloaded media: %s (%d bytes, %s)", savePath, len(data), mime)
	emit(Event{Type: "response", ReqID: cmd.ID, Success: true, Message: savePath})
}

func mimeToExt(mime string, fallback string) string {
	switch {
	case strings.Contains(mime, "jpeg") || strings.Contains(mime, "jpg"):
		return ".jpg"
	case strings.Contains(mime, "png"):
		return ".png"
	case strings.Contains(mime, "gif"):
		return ".gif"
	case strings.Contains(mime, "webp"):
		return ".webp"
	case strings.Contains(mime, "mp4"):
		return ".mp4"
	case strings.Contains(mime, "ogg"):
		return ".ogg"
	case strings.Contains(mime, "pdf"):
		return ".pdf"
	default:
		return fallback
	}
}

// ── Helpers ───────────────────────────────────────────────────────

func normalizeJID(recipient string) string {
	if strings.Contains(recipient, "@") {
		return recipient
	}
	// Strip non-digits
	digits := strings.Map(func(r rune) rune {
		if r >= '0' && r <= '9' {
			return r
		}
		return -1
	}, recipient)
	return digits + "@s.whatsapp.net"
}

func nilIfEmpty(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}
