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

	// contact
	PhoneJID     string  `json:"phone_jid,omitempty"`
	LID          string  `json:"lid,omitempty"`
	Notify       string  `json:"notify,omitempty"`
	VerifiedName *string `json:"verified_name"`

	// contacts_ready / history_sync
	Count    int `json:"count,omitempty"`
	Progress int `json:"progress,omitempty"`

	// error
	Message string `json:"message,omitempty"`

	// response (to commands)
	ReqID   string `json:"req_id,omitempty"`
	Success bool   `json:"success,omitempty"`
}

// ── Commands: Node.js -> Go (stdin) ───────────────────────────────

type Command struct {
	Cmd       string `json:"cmd"`
	ID        string `json:"id"`
	Recipient string `json:"recipient,omitempty"`
	Text      string `json:"text,omitempty"`
	Path      string `json:"path,omitempty"`
	Caption   string `json:"caption,omitempty"`
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
