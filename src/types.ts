// Hermeneia — shared types

export interface StoredMessage {
  id: string;
  chat_jid: string;
  sender: string;
  content: string;
  timestamp: string; // ISO-8601
  is_from_me: boolean;
  media_type: string | null;
  filename: string | null;
}

export interface StoredChat {
  jid: string;
  name: string | null;
  last_message_time: string | null; // ISO-8601
}

export interface Contact {
  phone_number: string;
  name: string | null;
  jid: string;
}

export interface MessageDict {
  id: string;
  timestamp: string;
  sender_jid: string;
  sender_phone: string;
  sender_name: string | null;
  sender_display: string | null;
  content: string;
  is_from_me: boolean;
  chat_jid: string;
  chat_name: string | null;
  media_type: string | null;
  account_id?: string;
}

export interface ChatDict {
  jid: string;
  name: string | null;
  is_group: boolean;
  last_message_time: string | null;
  last_message: string | null;
  last_sender: string | null;
  last_is_from_me: boolean | null;
  account_id?: string;
}

export interface ContactDict {
  phone_number: string;
  name: string | null;
  jid: string;
  account_id?: string;
}

export interface AccountInfo {
  id: string;
  name: string | null;
  phone: string | null;
  connected: boolean;
  authenticated: boolean;
}

export interface MessageContext {
  message: MessageDict;
  before: MessageDict[];
  after: MessageDict[];
}

export interface BridgeStatus {
  connected: boolean;
  authenticated: boolean;
  qr_url: string | null;
}
