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
  quiet_start: string | null;
  quiet_end: string | null;
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

type PushTokenRow = {
  user_id: string;
  token: string;
  platform: string;
  updated_at: string;
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

export type Database = {
  public: {
    Tables: {
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
          quiet_start?: string | null;
          quiet_end?: string | null;
          updated_at?: string;
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
      global_search: {
        Args: {
          p_ws: string;
          p_q: string;
        };
        Returns: Json;
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
