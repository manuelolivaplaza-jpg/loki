/**
 * Tipos de la base de datos de Loki en Supabase (Postgres).
 *
 * Escritos a mano a partir de `supabase/migrations/20260929000000_init.sql`
 * (T19) con la misma forma que genera `supabase gen types typescript`, para
 * que `supabase-js` pueda inferir las filas de `select`, `insert`, `update`
 * y los argumentos de las RPC sin la base de datos delante.
 *
 * Si cambia el esquema hay que regenerar/actualizar este archivo; la
 * migración es la fuente de la verdad.
 */

/** JSON de Postgres, tal y como lo devuelve PostgREST. */
export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[];

type ProfileRow = {
  id: string;
  email: string | null;
  display_name: string;
  avatar_color: string;
  current_workspace_id: string | null;
  theme: string;
  created_at: string;
  updated_at: string;
};

type WorkspaceRow = {
  id: string;
  name: string;
  emoji: string;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

type WorkspaceMemberRow = {
  workspace_id: string;
  user_id: string;
  role: string;
  display_name: string;
  joined_at: string;
};

type EventRow = {
  id: string;
  workspace_id: string;
  project_id: string | null;
  title: string;
  description: string;
  starts_at: string;
  ends_at: string;
  all_day: boolean;
  location: string;
  color: string;
  created_by: string | null;
  attendees: string[];
  reminder_minutes: number[];
  recurrence: string | null;
  external_id: string | null;
  external_source: string;
  created_at: string;
  updated_at: string;
};

type ProjectRow = {
  id: string;
  workspace_id: string;
  name: string;
  description: string;
  emoji: string;
  color: string;
  status: string;
  due_date: string | null;
  created_by: string | null;
  is_system: boolean;
  created_at: string;
  updated_at: string;
};

type TaskRow = {
  id: string;
  project_id: string;
  workspace_id: string;
  title: string;
  notes: string;
  status: string;
  priority: string;
  assignee_ids: string[];
  due_at: string | null;
  reminder_at: string | null;
  position: number;
  parent_task_id: string | null;
  completed_at: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

type IdeaRow = {
  id: string;
  workspace_id: string;
  title: string;
  detail: string;
  tag: string;
  created_by: string | null;
  converted_task_id: string | null;
  created_at: string;
  updated_at: string;
};

type NotificationRow = {
  id: string;
  user_id: string;
  workspace_id: string | null;
  type: string;
  title: string;
  body: string;
  link: string;
  read_at: string | null;
  dedupe: string | null;
  created_at: string;
};

type NotificationPrefsRow = {
  user_id: string;
  mention: boolean;
  reply: boolean;
  reaction: boolean;
  task_assigned: boolean;
  task_due: boolean;
  event_reminder: boolean;
  invite: boolean;
  ai_alert: boolean;
  list: boolean;
  poll: boolean;
  /** Memoria del espacio (20261009000000_space_memories.sql). */
  memory: boolean;
  /** Resumen diario "Tu día" (20261011000000_daily_digest.sql). */
  daily: boolean;
  /** Agentes personales (20261012000000_agents.sql). */
  agent: boolean;
  /** Compañero de escritorio (20261014000000_devices.sql). */
  device: boolean;
  quiet_start: string | null;
  quiet_end: string | null;
  updated_at: string;
};

/**
 * Preferencias del resumen diario (`daily_digest_prefs`, migración
 * `20261011000000_daily_digest.sql`). Sin fila = defaults (08:00,
 * America/Santiago, todos los días y espacios, sin aviso en vacío).
 */
type DailyDigestPrefsRow = {
  user_id: string;
  enabled: boolean;
  digest_time: string;
  timezone: string;
  days: string;
  workspace_ids: string[];
  send_when_empty: boolean;
  updated_at: string;
};

/**
 * Recuerdo del espacio (`space_memories`, migración
 * `20261009000000_space_memories.sql`).
 */
type SpaceMemoryRow = {
  id: string;
  workspace_id: string;
  content: string;
  category: string;
  sensitive: boolean;
  pinned: boolean;
  visibility: string;
  source_message_id: string | null;
  share_confirmed: boolean;
  created_by: string | null;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
};

/**
 * Ajustes de búsqueda por espacio (`workspace_search_settings`, migración
 * `20261010000000_search_all.sql`).
 */
type WorkspaceSearchSettingsRow = {
  workspace_id: string;
  ocr_enabled: boolean;
  updated_by: string | null;
  updated_at: string;
};

/**
 * Adjunto indexado para la búsqueda (`message_attachments`, migración
 * `20261010000000_search_all.sql`).
 */
type MessageAttachmentRow = {
  id: string;
  workspace_id: string;
  chat_id: string;
  message_id: string;
  bucket: string | null;
  object_path: string | null;
  name: string;
  mime: string;
  kind: string;
  size_bytes: number;
  author_id: string | null;
  author_name: string;
  ocr_text: string;
  ocr_status: string;
  created_at: string;
  updated_at: string;
};

type InviteRow = {
  id: string;
  code: string;
  workspace_id: string;
  created_by: string | null;
  role: string;
  expires_at: string | null;
  max_uses: number | null;
  uses: number;
  revoked_at: string | null;
  created_at: string;
};

type ChatRow = {
  workspace_id: string;
  id: string;
  type: string;
  name: string;
  emoji: string | null;
  member_ids: string[];
  created_by: string | null;
  last_message: Json | null;
  created_at: string;
  updated_at: string;
};

type MessageRow = {
  id: string;
  workspace_id: string;
  chat_id: string;
  author_id: string | null;
  author_name: string;
  text: string;
  type: string;
  mentions: string[];
  reply_to: Json | null;
  thread_parent_id: string | null;
  thread_count: number;
  last_reply_at: string | null;
  attachments: Json;
  edited_at: string | null;
  deleted: boolean;
  meta: Json;
  created_at: string;
};

type MessageReactionRow = {
  message_id: string;
  user_id: string;
  emoji: string;
  created_at: string;
};

type ChatReadRow = {
  workspace_id: string;
  chat_id: string;
  user_id: string;
  last_read_at: string;
};

type AiChatRow = {
  id: string;
  user_id: string;
  title: string;
  created_at: string;
  updated_at: string;
};

type AiMessageRow = {
  id: string;
  chat_id: string;
  type: string;
  content: string;
  created_at: string;
};

type AiJobRow = {
  id: string;
  workspace_id: string;
  requested_by: string | null;
  type: string;
  payload: Json;
  status: string;
  attempts: number;
  max_attempts: number;
  idempotency_key: string | null;
  result: Json | null;
  error: string | null;
  run_after: string | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
  updated_at: string;
};

type AudioTranscriptionRow = {
  id: string;
  workspace_id: string;
  bucket: string;
  object_path: string;
  message_id: string | null;
  chat_id: string | null;
  author_id: string | null;
  requested_by: string | null;
  text: string;
  language: string;
  duration_seconds: number | null;
  status: string;
  provider: string;
  error: string | null;
  created_at: string;
  updated_at: string;
};

type AiSpaceUsageRow = {
  workspace_id: string;
  day: string;
  units: number;
  calls: number;
  created_at: string;
  updated_at: string;
};

type AiSpaceUsageDetailRow = {
  workspace_id: string;
  day: string;
  user_id: string | null;
  job_type: string;
  units: number;
  calls: number;
};

type AiSpaceLimitRow = {
  workspace_id: string;
  daily_units: number | null;
  monthly_units: number | null;
  updated_by: string | null;
  updated_at: string;
};

type AiSummaryRow = {
  user_id: string;
  chat_key: string;
  summary: string;
  last_message_id: string | null;
  updated_at: string;
};

type MessageLinkRow = {
  id: string;
  workspace_id: string;
  message_id: string;
  kind: string;
  task_id: string | null;
  event_id: string | null;
  created_by: string | null;
  created_at: string;
};

type ShoppingListRow = {
  id: string;
  workspace_id: string;
  title: string;
  emoji: string;
  color: string;
  kind: string;
  pinned: boolean;
  archived: boolean;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

type ListItemRow = {
  id: string;
  list_id: string;
  workspace_id: string;
  text: string;
  quantity: string;
  unit: string;
  category: string;
  checked: boolean;
  checked_by: string | null;
  checked_at: string | null;
  assignee_id: string | null;
  due_at: string | null;
  position: number;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

type ListWatcherRow = {
  user_id: string;
  list_id: string;
  on_add: boolean;
  on_complete: boolean;
  created_at: string;
};

type PushTokenRow = {
  user_id: string;
  token: string;
  platform: string;
  updated_at: string;
};

type PollRow = {
  id: string;
  message_id: string;
  workspace_id: string;
  chat_id: string;
  question: string;
  kind: string;
  settings: Json;
  closes_at: string | null;
  closed_at: string | null;
  closed_by: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

type PollOptionRow = {
  id: string;
  poll_id: string;
  workspace_id: string;
  text: string;
  starts_at: string | null;
  ends_at: string | null;
  position: number;
  added_by: string | null;
  created_at: string;
};

type PollVoteRow = {
  id: string;
  poll_id: string;
  option_id: string;
  user_id: string;
  created_at: string;
};

type UserPresenceRow = {
  user_id: string;
  workspace_id: string | null;
  online: boolean;
  last_seen: string;
  status_emoji: string;
  status_text: string;
  updated_at: string;
};

/**
 * Conexión de agente personal (`agent_connections`, migración
 * `20261012000000_agents.sql`). Los secretos (`secret_enc`,
 * `inbound_token_hash`) tienen REVOKE a nivel de columna para
 * `authenticated`: el cliente usa listas explícitas de columnas, nunca `*`.
 */
type AgentConnectionRow = {
  id: string;
  owner_id: string;
  provider: string;
  name: string;
  handle: string;
  description: string;
  avatar_emoji: string;
  config: Json;
  secret_enc: string | null;
  inbound_token_hash: string | null;
  status: string;
  last_error: string | null;
  last_used_at: string | null;
  created_at: string;
  updated_at: string;
};

/** Habilitación por espacio con permisos (`agent_space_grants`). */
type AgentSpaceGrantRow = {
  id: string;
  connection_id: string;
  workspace_id: string;
  enabled: boolean;
  admin_disabled: boolean;
  allowed_callers: string;
  allowed_user_ids: string[];
  allow_context: boolean;
  context_messages: number;
  allow_dm_context: boolean;
  allow_publish: boolean;
  allow_propose_actions: boolean;
  daily_limit: number;
  created_at: string;
  updated_at: string;
};

/** Ejecución de un agente (`agent_runs`). `run_token_hash` tiene REVOKE a
 * nivel de columna: el cliente nunca lo selecciona.
 */
type AgentRunRow = {
  id: string;
  connection_id: string;
  workspace_id: string;
  chat_id: string;
  requested_by: string | null;
  kind: string;
  instruction: string;
  status: string;
  run_token_hash: string | null;
  token_expires_at: string | null;
  deadline_at: string | null;
  context: Json;
  history: Json;
  result: Json | null;
  error: string | null;
  cancel_requested_at: string | null;
  idempotency_key: string | null;
  message_id: string | null;
  created_at: string;
  updated_at: string;
  finished_at: string | null;
};

/** Evento del historial de una ejecución (`agent_run_events`). */
type AgentRunEventRow = {
  id: string;
  run_id: string;
  seq: number;
  type: string;
  text: string;
  percent: number | null;
  client_event_id: string | null;
  payload: Json;
  created_at: string;
};

/**
 * PC vinculado (`user_devices`, migración `20261014000000_devices.sql`).
 * `credential_hash` tiene REVOKE a nivel de columna: el cliente usa listas
 * explícitas de columnas seguras, nunca `*`.
 */
type UserDeviceRow = {
  id: string;
  owner_id: string;
  name: string;
  platform: string;
  app_version: string;
  allowed_actions: string[];
  readable_dirs: string[];
  can_send_files: boolean;
  allow_arbitrary: boolean;
  revoked_at: string | null;
  last_seen_at: string | null;
  created_at: string;
  updated_at: string;
};

/** Orden al PC del catálogo cerrado (`device_commands`). */
type DeviceCommandRow = {
  id: string;
  device_id: string;
  owner_id: string;
  workspace_id: string | null;
  chat_id: string;
  message_id: string | null;
  requested_by: string | null;
  action: string;
  params: Json;
  risk: string;
  status: string;
  result_text: string;
  result_path: string | null;
  result_mime: string;
  confirmed_by: string | null;
  confirmed_at: string | null;
  delivered_at: string | null;
  started_at: string | null;
  finished_at: string | null;
  expires_at: string;
  error: string | null;
  created_at: string;
  updated_at: string;
};

/** Auditoría inmutable de PCs (`device_audit_log`, solo inserción). */
type DeviceAuditRow = {
  id: string;
  device_id: string;
  owner_id: string;
  command_id: string | null;
  actor_id: string | null;
  action: string;
  detail: string;
  created_at: string;
};

export type Database = {
  public: {
    Tables: {
      audio_transcriptions: {
        Row: AudioTranscriptionRow;
        Insert: {
          id?: string;
          workspace_id: string;
          bucket?: string;
          object_path: string;
          message_id?: string | null;
          chat_id?: string | null;
          author_id?: string | null;
          requested_by?: string | null;
          text?: string;
          language?: string;
          duration_seconds?: number | null;
          status?: string;
          provider?: string;
          error?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          workspace_id?: string;
          bucket?: string;
          object_path?: string;
          message_id?: string | null;
          chat_id?: string | null;
          author_id?: string | null;
          requested_by?: string | null;
          text?: string;
          language?: string;
          duration_seconds?: number | null;
          status?: string;
          provider?: string;
          error?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "audio_transcriptions_message_id_fkey";
            columns: ["message_id"];
            isOneToOne: false;
            referencedRelation: "messages";
            referencedColumns: ["id"];
          },
        ];
      };
      ai_chats: {
        Row: AiChatRow;
        Insert: {
          id?: string;
          user_id?: string;
          title?: string;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          user_id?: string;
          title?: string;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "ai_chats_user_id_fkey";
            columns: ["user_id"];
            isOneToOne: false;
            referencedRelation: "users";
            referencedColumns: ["id"];
          },
        ];
      };
      ai_messages: {
        Row: AiMessageRow;
        Insert: {
          id?: string;
          chat_id: string;
          type?: string;
          content?: string;
          created_at?: string;
        };
        Update: {
          id?: string;
          chat_id?: string;
          type?: string;
          content?: string;
          created_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "ai_messages_chat_id_fkey";
            columns: ["chat_id"];
            isOneToOne: false;
            referencedRelation: "ai_chats";
            referencedColumns: ["id"];
          },
        ];
      };
      ai_jobs: {
        Row: AiJobRow;
        Insert: {
          id?: string;
          workspace_id: string;
          requested_by?: string | null;
          type: string;
          payload?: Json;
          status?: string;
          attempts?: number;
          max_attempts?: number;
          idempotency_key?: string | null;
          result?: Json | null;
          error?: string | null;
          run_after?: string | null;
          started_at?: string | null;
          finished_at?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          workspace_id?: string;
          requested_by?: string | null;
          type?: string;
          payload?: Json;
          status?: string;
          attempts?: number;
          max_attempts?: number;
          idempotency_key?: string | null;
          result?: Json | null;
          error?: string | null;
          run_after?: string | null;
          started_at?: string | null;
          finished_at?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      ai_space_limits: {
        Row: AiSpaceLimitRow;
        Insert: {
          workspace_id: string;
          daily_units?: number | null;
          monthly_units?: number | null;
          updated_by?: string | null;
          updated_at?: string;
        };
        Update: {
          workspace_id?: string;
          daily_units?: number | null;
          monthly_units?: number | null;
          updated_by?: string | null;
          updated_at?: string;
        };
        Relationships: [];
      };
      ai_space_usage: {
        Row: AiSpaceUsageRow;
        Insert: {
          workspace_id: string;
          day?: string;
          units?: number;
          calls?: number;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          workspace_id?: string;
          day?: string;
          units?: number;
          calls?: number;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      ai_space_usage_detail: {
        Row: AiSpaceUsageDetailRow;
        Insert: {
          workspace_id: string;
          day?: string;
          user_id?: string | null;
          job_type?: string;
          units?: number;
          calls?: number;
        };
        Update: {
          workspace_id?: string;
          day?: string;
          user_id?: string | null;
          job_type?: string;
          units?: number;
          calls?: number;
        };
        Relationships: [];
      };
      ai_summaries: {
        Row: AiSummaryRow;
        Insert: {
          user_id: string;
          chat_key: string;
          summary?: string;
          last_message_id?: string | null;
          updated_at?: string;
        };
        Update: {
          user_id?: string;
          chat_key?: string;
          summary?: string;
          last_message_id?: string | null;
          updated_at?: string;
        };
        Relationships: [];
      };
      chat_reads: {
        Row: ChatReadRow;
        Insert: {
          workspace_id: string;
          chat_id: string;
          user_id: string;
          last_read_at?: string;
        };
        Update: {
          workspace_id?: string;
          chat_id?: string;
          user_id?: string;
          last_read_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "chat_reads_chat_fk";
            columns: ["workspace_id", "chat_id"];
            isOneToOne: false;
            referencedRelation: "chats";
            referencedColumns: ["workspace_id", "id"];
          },
          {
            foreignKeyName: "chat_reads_user_id_fkey";
            columns: ["user_id"];
            isOneToOne: false;
            referencedRelation: "users";
            referencedColumns: ["id"];
          },
        ];
      };
      chats: {
        Row: ChatRow;
        Insert: {
          workspace_id: string;
          id: string;
          type: string;
          name: string;
          emoji?: string | null;
          member_ids?: string[];
          created_by?: string | null;
          last_message?: Json | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          workspace_id?: string;
          id?: string;
          type?: string;
          name?: string;
          emoji?: string | null;
          member_ids?: string[];
          created_by?: string | null;
          last_message?: Json | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "chats_created_by_fkey";
            columns: ["created_by"];
            isOneToOne: false;
            referencedRelation: "users";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "chats_workspace_id_fkey";
            columns: ["workspace_id"];
            isOneToOne: false;
            referencedRelation: "workspaces";
            referencedColumns: ["id"];
          },
        ];
      };
      message_reactions: {
        Row: MessageReactionRow;
        Insert: {
          message_id: string;
          user_id: string;
          emoji: string;
          created_at?: string;
        };
        Update: {
          message_id?: string;
          user_id?: string;
          emoji?: string;
          created_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "message_reactions_message_id_fkey";
            columns: ["message_id"];
            isOneToOne: false;
            referencedRelation: "messages";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "message_reactions_user_id_fkey";
            columns: ["user_id"];
            isOneToOne: false;
            referencedRelation: "users";
            referencedColumns: ["id"];
          },
        ];
      };
      message_attachments: {
        Row: MessageAttachmentRow;
        Insert: {
          id?: string;
          workspace_id: string;
          chat_id: string;
          message_id: string;
          bucket?: string | null;
          object_path?: string | null;
          name?: string;
          mime?: string;
          kind?: string;
          size_bytes?: number;
          author_id?: string | null;
          author_name?: string;
          ocr_text?: string;
          ocr_status?: string;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          workspace_id?: string;
          chat_id?: string;
          message_id?: string;
          bucket?: string | null;
          object_path?: string | null;
          name?: string;
          mime?: string;
          kind?: string;
          size_bytes?: number;
          author_id?: string | null;
          author_name?: string;
          ocr_text?: string;
          ocr_status?: string;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "message_attachments_message_id_fkey";
            columns: ["message_id"];
            isOneToOne: false;
            referencedRelation: "messages";
            referencedColumns: ["id"];
          },
        ];
      };
      messages: {
        Row: MessageRow;
        Insert: {
          id?: string;
          workspace_id: string;
          chat_id: string;
          author_id?: string | null;
          author_name?: string;
          text?: string;
          type?: string;
          mentions?: string[];
          reply_to?: Json | null;
          thread_parent_id?: string | null;
          thread_count?: number;
          last_reply_at?: string | null;
          attachments?: Json;
          edited_at?: string | null;
          deleted?: boolean;
          meta?: Json;
          created_at?: string;
        };
        Update: {
          id?: string;
          workspace_id?: string;
          chat_id?: string;
          author_id?: string | null;
          author_name?: string;
          text?: string;
          type?: string;
          mentions?: string[];
          reply_to?: Json | null;
          thread_parent_id?: string | null;
          thread_count?: number;
          last_reply_at?: string | null;
          attachments?: Json;
          edited_at?: string | null;
          deleted?: boolean;
          meta?: Json;
          created_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "messages_author_id_fkey";
            columns: ["author_id"];
            isOneToOne: false;
            referencedRelation: "users";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "messages_chat_fk";
            columns: ["workspace_id", "chat_id"];
            isOneToOne: false;
            referencedRelation: "chats";
            referencedColumns: ["workspace_id", "id"];
          },
          {
            foreignKeyName: "messages_thread_parent_id_fkey";
            columns: ["thread_parent_id"];
            isOneToOne: true;
            referencedRelation: "messages";
            referencedColumns: ["id"];
          },
        ];
      };
      lists: {
        Row: ShoppingListRow;
        Insert: {
          id?: string;
          workspace_id: string;
          title: string;
          emoji?: string;
          color?: string;
          kind?: string;
          pinned?: boolean;
          archived?: boolean;
          created_by?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          workspace_id?: string;
          title?: string;
          emoji?: string;
          color?: string;
          kind?: string;
          pinned?: boolean;
          archived?: boolean;
          created_by?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      list_items: {
        Row: ListItemRow;
        Insert: {
          id?: string;
          list_id: string;
          workspace_id: string;
          text: string;
          quantity?: string;
          unit?: string;
          category?: string;
          checked?: boolean;
          checked_by?: string | null;
          checked_at?: string | null;
          assignee_id?: string | null;
          due_at?: string | null;
          position?: number;
          created_by?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          list_id?: string;
          workspace_id?: string;
          text?: string;
          quantity?: string;
          unit?: string;
          category?: string;
          checked?: boolean;
          checked_by?: string | null;
          checked_at?: string | null;
          assignee_id?: string | null;
          due_at?: string | null;
          position?: number;
          created_by?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      list_watchers: {
        Row: ListWatcherRow;
        Insert: {
          user_id: string;
          list_id: string;
          on_add?: boolean;
          on_complete?: boolean;
          created_at?: string;
        };
        Update: {
          user_id?: string;
          list_id?: string;
          on_add?: boolean;
          on_complete?: boolean;
          created_at?: string;
        };
        Relationships: [];
      };
      message_links: {
        Row: MessageLinkRow;
        Insert: {
          id?: string;
          workspace_id: string;
          message_id: string;
          kind: string;
          task_id?: string | null;
          event_id?: string | null;
          created_by?: string | null;
          created_at?: string;
        };
        Update: {
          id?: string;
          workspace_id?: string;
          message_id?: string;
          kind?: string;
          task_id?: string | null;
          event_id?: string | null;
          created_by?: string | null;
          created_at?: string;
        };
        Relationships: [];
      };
      profiles: {
        Row: ProfileRow;
        Insert: {
          id: string;
          email?: string | null;
          display_name?: string;
          avatar_color?: string;
          current_workspace_id?: string | null;
          theme?: string;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          email?: string | null;
          display_name?: string;
          avatar_color?: string;
          current_workspace_id?: string | null;
          theme?: string;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "profiles_current_workspace_id_fkey";
            columns: ["current_workspace_id"];
            isOneToOne: false;
            referencedRelation: "workspaces";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "profiles_id_fkey";
            columns: ["id"];
            isOneToOne: true;
            referencedRelation: "users";
            referencedColumns: ["id"];
          },
        ];
      };
      push_tokens: {
        Row: PushTokenRow;
        Insert: {
          user_id?: string;
          token: string;
          platform?: string;
          updated_at?: string;
        };
        Update: {
          user_id?: string;
          token?: string;
          platform?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "push_tokens_user_id_fkey";
            columns: ["user_id"];
            isOneToOne: false;
            referencedRelation: "users";
            referencedColumns: ["id"];
          },
        ];
      };
      events: {
        Row: EventRow;
        Insert: {
          id?: string;
          workspace_id: string;
          project_id?: string | null;
          title: string;
          description?: string;
          starts_at: string;
          ends_at: string;
          all_day?: boolean;
          location?: string;
          color?: string;
          created_by?: string | null;
          attendees?: string[];
          reminder_minutes?: number[];
          recurrence?: string | null;
          external_id?: string | null;
          external_source?: string;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          workspace_id?: string;
          project_id?: string | null;
          title?: string;
          description?: string;
          starts_at?: string;
          ends_at?: string;
          all_day?: boolean;
          location?: string;
          color?: string;
          created_by?: string | null;
          attendees?: string[];
          reminder_minutes?: number[];
          recurrence?: string | null;
          external_id?: string | null;
          external_source?: string;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      projects: {
        Row: ProjectRow;
        Insert: {
          id?: string;
          workspace_id: string;
          name: string;
          description?: string;
          emoji?: string;
          color?: string;
          status?: string;
          due_date?: string | null;
          created_by?: string | null;
          is_system?: boolean;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          workspace_id?: string;
          name?: string;
          description?: string;
          emoji?: string;
          color?: string;
          status?: string;
          due_date?: string | null;
          created_by?: string | null;
          is_system?: boolean;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      tasks: {
        Row: TaskRow;
        Insert: {
          id?: string;
          project_id: string;
          workspace_id: string;
          title: string;
          notes?: string;
          status?: string;
          priority?: string;
          assignee_ids?: string[];
          due_at?: string | null;
          reminder_at?: string | null;
          position?: number;
          parent_task_id?: string | null;
          completed_at?: string | null;
          created_by?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          project_id?: string;
          workspace_id?: string;
          title?: string;
          notes?: string;
          status?: string;
          priority?: string;
          assignee_ids?: string[];
          due_at?: string | null;
          reminder_at?: string | null;
          position?: number;
          parent_task_id?: string | null;
          completed_at?: string | null;
          created_by?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      ideas: {
        Row: IdeaRow;
        Insert: {
          id?: string;
          workspace_id: string;
          title: string;
          detail?: string;
          tag?: string;
          created_by?: string | null;
          converted_task_id?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          workspace_id?: string;
          title?: string;
          detail?: string;
          tag?: string;
          created_by?: string | null;
          converted_task_id?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      notifications: {
        Row: NotificationRow;
        Insert: {
          id?: string;
          user_id: string;
          workspace_id?: string | null;
          type: string;
          title: string;
          body?: string;
          link?: string;
          read_at?: string | null;
          dedupe?: string | null;
          created_at?: string;
        };
        Update: {
          id?: string;
          user_id?: string;
          workspace_id?: string | null;
          type?: string;
          title?: string;
          body?: string;
          link?: string;
          read_at?: string | null;
          dedupe?: string | null;
          created_at?: string;
        };
        Relationships: [];
      };
      notification_prefs: {
        Row: NotificationPrefsRow;
        Insert: {
          user_id: string;
          mention?: boolean;
          reply?: boolean;
          reaction?: boolean;
          task_assigned?: boolean;
          task_due?: boolean;
          event_reminder?: boolean;
          invite?: boolean;
          ai_alert?: boolean;
          list?: boolean;
          poll?: boolean;
          memory?: boolean;
          daily?: boolean;
          agent?: boolean;
          device?: boolean;
          quiet_start?: string | null;
          quiet_end?: string | null;
          updated_at?: string;
        };
        Update: {
          user_id?: string;
          mention?: boolean;
          reply?: boolean;
          reaction?: boolean;
          task_assigned?: boolean;
          task_due?: boolean;
          event_reminder?: boolean;
          invite?: boolean;
          ai_alert?: boolean;
          list?: boolean;
          poll?: boolean;
          memory?: boolean;
          daily?: boolean;
          agent?: boolean;
          device?: boolean;
          quiet_start?: string | null;
          quiet_end?: string | null;
          updated_at?: string;
        };
        Relationships: [];
      };
      daily_digest_prefs: {
        Row: DailyDigestPrefsRow;
        Insert: {
          user_id: string;
          enabled?: boolean;
          digest_time?: string;
          timezone?: string;
          days?: string;
          workspace_ids?: string[];
          send_when_empty?: boolean;
          updated_at?: string;
        };
        Update: {
          user_id?: string;
          enabled?: boolean;
          digest_time?: string;
          timezone?: string;
          days?: string;
          workspace_ids?: string[];
          send_when_empty?: boolean;
          updated_at?: string;
        };
        Relationships: [];
      };
      space_memories: {
        Row: SpaceMemoryRow;
        Insert: {
          id?: string;
          workspace_id: string;
          content: string;
          category?: string;
          sensitive?: boolean;
          pinned?: boolean;
          visibility?: string;
          source_message_id?: string | null;
          share_confirmed?: boolean;
          created_by?: string | null;
          expires_at?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          workspace_id?: string;
          content?: string;
          category?: string;
          sensitive?: boolean;
          pinned?: boolean;
          visibility?: string;
          source_message_id?: string | null;
          share_confirmed?: boolean;
          created_by?: string | null;
          expires_at?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "space_memories_source_message_id_fkey";
            columns: ["source_message_id"];
            isOneToOne: false;
            referencedRelation: "messages";
            referencedColumns: ["id"];
          },
        ];
      };
      polls: {
        Row: PollRow;
        Insert: {
          id?: string;
          message_id: string;
          workspace_id: string;
          chat_id: string;
          question: string;
          kind?: string;
          settings?: Json;
          closes_at?: string | null;
          closed_at?: string | null;
          closed_by?: string | null;
          created_by?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          message_id?: string;
          workspace_id?: string;
          chat_id?: string;
          question?: string;
          kind?: string;
          settings?: Json;
          closes_at?: string | null;
          closed_at?: string | null;
          closed_by?: string | null;
          created_by?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      poll_options: {
        Row: PollOptionRow;
        Insert: {
          id?: string;
          poll_id: string;
          workspace_id: string;
          text: string;
          starts_at?: string | null;
          ends_at?: string | null;
          position?: number;
          added_by?: string | null;
          created_at?: string;
        };
        Update: {
          id?: string;
          poll_id?: string;
          workspace_id?: string;
          text?: string;
          starts_at?: string | null;
          ends_at?: string | null;
          position?: number;
          added_by?: string | null;
          created_at?: string;
        };
        Relationships: [];
      };
      poll_votes: {
        Row: PollVoteRow;
        Insert: {
          id?: string;
          poll_id: string;
          option_id: string;
          user_id?: string;
          created_at?: string;
        };
        Update: {
          id?: string;
          poll_id?: string;
          option_id?: string;
          user_id?: string;
          created_at?: string;
        };
        Relationships: [];
      };
      invites: {
        Row: InviteRow;
        Insert: {
          id?: string;
          code?: string;
          workspace_id: string;
          created_by?: string | null;
          role?: string;
          expires_at?: string | null;
          max_uses?: number | null;
          uses?: number;
          revoked_at?: string | null;
          created_at?: string;
        };
        Update: {
          id?: string;
          code?: string;
          workspace_id?: string;
          created_by?: string | null;
          role?: string;
          expires_at?: string | null;
          max_uses?: number | null;
          uses?: number;
          revoked_at?: string | null;
          created_at?: string;
        };
        Relationships: [];
      };
      workspace_members: {
        Row: WorkspaceMemberRow;
        Insert: {
          workspace_id: string;
          user_id: string;
          role?: string;
          display_name?: string;
          joined_at?: string;
        };
        Update: {
          workspace_id?: string;
          user_id?: string;
          role?: string;
          display_name?: string;
          joined_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "workspace_members_user_id_fkey";
            columns: ["user_id"];
            isOneToOne: false;
            referencedRelation: "users";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "workspace_members_workspace_id_fkey";
            columns: ["workspace_id"];
            isOneToOne: false;
            referencedRelation: "workspaces";
            referencedColumns: ["id"];
          },
        ];
      };
      user_presence: {
        Row: UserPresenceRow;
        Insert: {
          user_id: string;
          workspace_id?: string | null;
          online?: boolean;
          last_seen?: string;
          status_emoji?: string;
          status_text?: string;
          updated_at?: string;
        };
        Update: {
          user_id?: string;
          workspace_id?: string | null;
          online?: boolean;
          last_seen?: string;
          status_emoji?: string;
          status_text?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "user_presence_user_id_fkey";
            columns: ["user_id"];
            isOneToOne: true;
            referencedRelation: "users";
            referencedColumns: ["id"];
          },
        ];
      };
      workspaces: {
        Row: WorkspaceRow;
        Insert: {
          id?: string;
          name: string;
          emoji?: string;
          created_by?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          name?: string;
          emoji?: string;
          created_by?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "workspaces_created_by_fkey";
            columns: ["created_by"];
            isOneToOne: false;
            referencedRelation: "users";
            referencedColumns: ["id"];
          },
        ];
      };
      workspace_search_settings: {
        Row: WorkspaceSearchSettingsRow;
        Insert: {
          workspace_id: string;
          ocr_enabled?: boolean;
          updated_by?: string | null;
          updated_at?: string;
        };
        Update: {
          workspace_id?: string;
          ocr_enabled?: boolean;
          updated_by?: string | null;
          updated_at?: string;
        };
        Relationships: [];
      };
      agent_connections: {
        Row: AgentConnectionRow;
        Insert: {
          id?: string;
          owner_id: string;
          provider: string;
          name: string;
          handle: string;
          description?: string;
          avatar_emoji?: string;
          config?: Json;
          status?: string;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          provider?: string;
          name?: string;
          handle?: string;
          description?: string;
          avatar_emoji?: string;
          config?: Json;
          status?: string;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      agent_space_grants: {
        Row: AgentSpaceGrantRow;
        Insert: {
          id?: string;
          connection_id: string;
          workspace_id: string;
          enabled?: boolean;
          admin_disabled?: boolean;
          allowed_callers?: string;
          allowed_user_ids?: string[];
          allow_context?: boolean;
          context_messages?: number;
          allow_dm_context?: boolean;
          allow_publish?: boolean;
          allow_propose_actions?: boolean;
          daily_limit?: number;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          connection_id?: string;
          workspace_id?: string;
          enabled?: boolean;
          admin_disabled?: boolean;
          allowed_callers?: string;
          allowed_user_ids?: string[];
          allow_context?: boolean;
          context_messages?: number;
          allow_dm_context?: boolean;
          allow_publish?: boolean;
          allow_propose_actions?: boolean;
          daily_limit?: number;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      agent_runs: {
        Row: AgentRunRow;
        Insert: {
          id?: string;
          connection_id: string;
          workspace_id: string;
          chat_id: string;
          requested_by?: string | null;
          kind?: string;
          instruction?: string;
          idempotency_key?: string | null;
          message_id?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          connection_id?: string;
          workspace_id?: string;
          chat_id?: string;
          requested_by?: string | null;
          kind?: string;
          instruction?: string;
          idempotency_key?: string | null;
          message_id?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      agent_run_events: {
        Row: AgentRunEventRow;
        Insert: {
          id?: string;
          run_id: string;
          seq: number;
          type: string;
          text?: string;
          percent?: number | null;
          client_event_id?: string | null;
          payload?: Json;
          created_at?: string;
        };
        Update: {
          id?: string;
          run_id?: string;
          seq?: number;
          type?: string;
          text?: string;
          percent?: number | null;
          client_event_id?: string | null;
          payload?: Json;
          created_at?: string;
        };
        Relationships: [];
      };
      user_devices: {
        Row: UserDeviceRow;
        Insert: {
          id?: string;
          owner_id: string;
          name: string;
          platform?: string;
          app_version?: string;
          credential_hash?: string;
          allowed_actions?: string[];
          readable_dirs?: string[];
          can_send_files?: boolean;
          allow_arbitrary?: boolean;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          name?: string;
          platform?: string;
          app_version?: string;
          allowed_actions?: string[];
          readable_dirs?: string[];
          can_send_files?: boolean;
          allow_arbitrary?: boolean;
        };
        Relationships: [];
      };
      device_commands: {
        Row: DeviceCommandRow;
        Insert: {
          id?: string;
          device_id: string;
          owner_id: string;
          workspace_id?: string | null;
          chat_id?: string;
          message_id?: string | null;
          requested_by?: string | null;
          action: string;
          params?: Json;
          risk: string;
          status?: string;
        };
        Update: {
          id?: string;
          status?: string;
        };
        Relationships: [];
      };
      device_audit_log: {
        Row: DeviceAuditRow;
        Insert: {
          id?: string;
          device_id: string;
          owner_id: string;
          command_id?: string | null;
          actor_id?: string | null;
          action: string;
          detail?: string;
          created_at?: string;
        };
        Update: {
          id?: string;
          device_id?: string;
          owner_id?: string;
          command_id?: string | null;
          actor_id?: string | null;
          action?: string;
          detail?: string;
          created_at?: string;
        };
        Relationships: [];
      };
    };
    Views: {
      post_likes: {
        Row: {
          post_id: string;
          user_id: string;
          created_at: string;
        };
        Insert: never;
        Update: never;
        Relationships: [];
      };
      posts: {
        Row: {
          id: string;
          workspace_id: string;
          author_id: string | null;
          author_name: string;
          text: string;
          mentions: string[];
          thread_count: number;
          last_reply_at: string | null;
          attachments: Json;
          edited_at: string | null;
          deleted: boolean;
          created_at: string;
        };
        Insert: never;
        Update: never;
        Relationships: [];
      };
      project_progress: {
        Row: {
          project_id: string;
          total: number;
          done: number;
        };
        Insert: never;
        Update: never;
        Relationships: [];
      };
    };
    Functions: {
      accept_invite: {
        Args: {
          p_code: string;
        };
        Returns: Json;
      };
      generate_invite_code: {
        Args: Record<string, never>;
        Returns: string;
      };
      is_space_admin: {
        Args: {
          p_workspace_id: string;
        };
        Returns: boolean;
      };
      can_access_chat: {
        Args: {
          p_workspace_id: string;
          p_chat_id: string;
        };
        Returns: boolean;
      };
      create_workspace: {
        Args: {
          p_name: string;
          p_emoji?: string;
        };
        Returns: string;
      };
      ensure_posts_chat: {
        Args: {
          p_workspace_id: string;
        };
        Returns: boolean;
      };
      ensure_inbox_project: {
        Args: {
          p_workspace_id: string;
        };
        Returns: string;
      };
      log_loki_action: {
        Args: {
          p_workspace_id: string;
          p_actor_id: string;
          p_target_id: string;
          p_action: string;
          p_limit_hour: number;
        };
        Returns: boolean;
      };
      global_search: {
        Args: {
          p_ws: string;
          p_q: string;
          p_types?: string[] | null;
          p_chat?: string | null;
          p_author?: string | null;
          p_mine?: boolean | null;
          p_from?: string | null;
          p_to?: string | null;
          p_limit?: number | null;
        };
        Returns: Json;
      };
      search_more: {
        Args: {
          p_ws: string;
          p_q: string;
          p_group: string;
          p_limit?: number | null;
          p_offset?: number | null;
          p_chat?: string | null;
          p_author?: string | null;
          p_mine?: boolean | null;
          p_from?: string | null;
          p_to?: string | null;
        };
        Returns: Json;
      };
      search_space_memories: {
        Args: {
          p_ws: string;
          p_query: string;
          p_limit?: number;
        };
        Returns: Json;
      };
      memory_query_terms: {
        Args: {
          p_query: string;
        };
        Returns: string[];
      };
      notify_expiring_memories: {
        Args: Record<string, never>;
        Returns: number;
      };
      is_member: {
        Args: {
          p_workspace_id: string;
        };
        Returns: boolean;
      };
      is_owner: {
        Args: {
          p_workspace_id: string;
        };
        Returns: boolean;
      };
      reserve_ai_quota: {
        Args: {
          p_workspace_id: string;
          p_user_id: string;
          p_job_type: string;
          p_units: number;
        };
        Returns: Json;
      };
      retry_ai_job: {
        Args: {
          p_job_id: string;
        };
        Returns: boolean;
      };
      retry_transcription: {
        Args: {
          p_transcription_id: string;
        };
        Returns: boolean;
      };
      poll_results: {
        Args: {
          p_poll_id: string;
        };
        Returns: Json;
      };
      cast_poll_vote: {
        Args: {
          p_poll_id: string;
          p_option_ids: string[];
        };
        Returns: boolean;
      };
      poll_option_busy: {
        Args: {
          p_poll_id: string;
        };
        Returns: Json;
      };
      close_poll: {
        Args: {
          p_poll_id: string;
        };
        Returns: boolean;
      };
      create_daily_digests: {
        Args: Record<string, never>;
        Returns: number;
      };
      agent_connection_owner: {
        Args: {
          p_connection_id: string;
        };
        Returns: string;
      };
      agent_can_invoke: {
        Args: {
          p_connection_id: string;
          p_workspace_id: string;
        };
        Returns: boolean;
      };
      agent_can_read_run: {
        Args: {
          p_run_id: string;
        };
        Returns: boolean;
      };
      validate_agent_handle: {
        Args: {
          p_workspace_id: string;
          p_handle: string;
          p_ignore_connection_id?: string | null;
        };
        Returns: boolean;
      };
      request_agent_run_cancel: {
        Args: {
          p_run_id: string;
        };
        Returns: boolean;
      };
      agent_continue_run: {
        Args: {
          p_run_id: string;
          p_text: string;
        };
        Returns: boolean;
      };
      expire_agent_runs: {
        Args: Record<string, never>;
        Returns: number;
      };
      set_agent_grant_admin_disabled: {
        Args: {
          p_grant_id: string;
          p_disabled: boolean;
        };
        Returns: boolean;
      };
      create_device_pair_code: {
        Args: {
          p_name: string;
        };
        Returns: string;
      };
      revoke_device: {
        Args: {
          p_device_id: string;
        };
        Returns: boolean;
      };
      request_device_command: {
        Args: {
          p_device_id: string;
          p_action: string;
          p_params: Json;
          p_workspace_id: string | null;
          p_chat_id: string;
          p_message_id?: string | null;
        };
        Returns: Json;
      };
      confirm_device_command: {
        Args: {
          p_command_id: string;
          p_ok: boolean;
        };
        Returns: boolean;
      };
      update_device_settings: {
        Args: {
          p_device_id: string;
          p_name?: string | null;
          p_allowed_actions?: string[] | null;
          p_readable_dirs?: string[] | null;
          p_can_send_files?: boolean | null;
          p_allow_arbitrary?: boolean | null;
        };
        Returns: boolean;
      };
      can_order_device: {
        Args: {
          p_device_id: string;
          p_workspace_id: string | null;
          p_chat_id: string;
        };
        Returns: boolean;
      };
      device_command_rate_ok: {
        Args: {
          p_device_id: string;
        };
        Returns: boolean;
      };
    };
    Enums: {
      [_ in never]: never;
    };
    CompositeTypes: {
      [_ in never]: never;
    };
  };
};

/** Fila de `profiles` tal y como la devuelve PostgREST. */
export type ProfileTableRow = Database["public"]["Tables"]["profiles"]["Row"];

/** Fila de `workspace_members` con el espacio embebido (listado de espacios). */
export type WorkspaceMembershipRow =
  Database["public"]["Tables"]["workspace_members"]["Row"] & {
    workspaces: Pick<WorkspaceRow, "id" | "name" | "emoji"> | null;
  };
