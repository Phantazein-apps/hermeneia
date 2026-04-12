package main

import (
	"encoding/json"
	"fmt"
	"os"
	"sync"
)

// ── Events: Go -> Node.js (stdout) ────────────────────────────────

type Event struct {
	Type string `json:"type"`

	// qr
	Data string `json:"data,omitempty"`

	// message
	ID        string  `json:"id,omitempty"`
	ChatJID   string  `json:"chat_jid,omitempty"`
	Sender    string  `json:"sender,omitempty"`
	Content   string  `json:"content,omitempty"`
	IsFromMe  bool    `json:"is_from_me,omitempty"`
	Timestamp string  `json:"timestamp,omitempty"`
	MediaType *string `json:"media_type"`
	PushName  string  `json:"push_name,omitempty"`

	// chat
	JID             string `json:"jid,omitempty"`
	Name            string `json:"name,omitempty"`
	LastMessageTime string `json:"last_message_time,omitempty"`
	UnreadCount     *int   `json:"unread_count,omitempty"`
	MarkedAsUnread  *bool  `json:"marked_as_unread,omitempty"`

	// contact
	PhoneJID     string  `json:"phone_jid,omitempty"`
	LID          string  `json:"lid,omitempty"`
	Notify       string  `json:"notify,omitempty"`
	VerifiedName *string `json:"verified_name"`

	// contacts_ready / history_sync
	Count    int `json:"count,omitempty"`
	Progress int `json:"progress,omitempty"`

	// media download metadata (persisted by Node for later downloads)
	MediaInfo *MediaInfo `json:"media_info,omitempty"`

	// error
	Message string `json:"message,omitempty"`

	// response (to commands)
	ReqID   string `json:"req_id,omitempty"`
	Success bool   `json:"success,omitempty"`
}

// MediaInfo holds the fields needed to download media from WhatsApp servers.
// Emitted with message events and passed back in download_media commands.
type MediaInfo struct {
	MediaType     string `json:"media_type"`
	Mimetype      string `json:"mimetype"`
	MediaKey      []byte `json:"media_key"`
	DirectPath    string `json:"direct_path"`
	URL           string `json:"url,omitempty"`
	FileEncSHA256 []byte `json:"file_enc_sha256"`
	FileSHA256    []byte `json:"file_sha256"`
	FileLength    uint64 `json:"file_length"`
	Filename      string `json:"filename,omitempty"`
}

// ── Commands: Node.js -> Go (stdin) ───────────────────────────────

type Command struct {
	Cmd       string `json:"cmd"`
	ID        string `json:"id"`
	Recipient string `json:"recipient,omitempty"`
	Text      string `json:"text,omitempty"`
	Path      string `json:"path,omitempty"`
	Caption   string `json:"caption,omitempty"`
	MessageID string     `json:"message_id,omitempty"`
	ChatJID   string     `json:"chat_jid,omitempty"`
	SaveDir   string     `json:"save_dir,omitempty"`
	MediaInfo *MediaInfo `json:"media_info,omitempty"`
}

// ── Thread-safe stdout writer ─────────────────────────────────────

var (
	writeMu sync.Mutex
	encoder = json.NewEncoder(os.Stdout)
)

func emit(evt Event) {
	writeMu.Lock()
	defer writeMu.Unlock()
	if err := encoder.Encode(evt); err != nil {
		fmt.Fprintf(os.Stderr, "[bridge] emit error: %v\n", err)
	}
}

func logf(format string, args ...interface{}) {
	fmt.Fprintf(os.Stderr, "[bridge] "+format+"\n", args...)
}
