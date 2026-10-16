export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[];

/** Minimal RPC schema; table reads/writes are intentionally not public API. */
export type Database = {
  public: {
    Tables: { [_ in never]: never };
    Views: { [_ in never]: never };
    Functions: {
      create_online_game: { Args: { p_color_choice: string }; Returns: Json };
      get_online_game: { Args: { p_id: string }; Returns: Json };
    };
    Enums: { [_ in never]: never };
    CompositeTypes: { [_ in never]: never };
  };
};
