export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      audit_logs: {
        Row: {
          action: string
          created_at: string
          details: string | null
          id: string
          user_id: string | null
        }
        Insert: {
          action: string
          created_at?: string
          details?: string | null
          id?: string
          user_id?: string | null
        }
        Update: {
          action?: string
          created_at?: string
          details?: string | null
          id?: string
          user_id?: string | null
        }
        Relationships: []
      }
      exam_assignments: {
        Row: {
          exam_id: string
          student_id: string
        }
        Insert: {
          exam_id: string
          student_id: string
        }
        Update: {
          exam_id?: string
          student_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "exam_assignments_exam_id_fkey"
            columns: ["exam_id"]
            isOneToOne: false
            referencedRelation: "exams"
            referencedColumns: ["id"]
          },
        ]
      }
      exam_questions: {
        Row: {
          exam_id: string
          id: string
          question_id: string
          question_order: number
        }
        Insert: {
          exam_id: string
          id?: string
          question_id: string
          question_order: number
        }
        Update: {
          exam_id?: string
          id?: string
          question_id?: string
          question_order?: number
        }
        Relationships: [
          {
            foreignKeyName: "exam_questions_exam_id_fkey"
            columns: ["exam_id"]
            isOneToOne: false
            referencedRelation: "exams"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "exam_questions_question_id_fkey"
            columns: ["question_id"]
            isOneToOne: false
            referencedRelation: "questions"
            referencedColumns: ["id"]
          },
        ]
      }
      exam_results: {
        Row: {
          created_at: string
          id: string
          percentile: number | null
          rank: number | null
          student_exam_id: string
          subject_wise_scores: Json
          total_correct: number
          total_unattempted: number
          total_wrong: number
        }
        Insert: {
          created_at?: string
          id?: string
          percentile?: number | null
          rank?: number | null
          student_exam_id: string
          subject_wise_scores?: Json
          total_correct?: number
          total_unattempted?: number
          total_wrong?: number
        }
        Update: {
          created_at?: string
          id?: string
          percentile?: number | null
          rank?: number | null
          student_exam_id?: string
          subject_wise_scores?: Json
          total_correct?: number
          total_unattempted?: number
          total_wrong?: number
        }
        Relationships: [
          {
            foreignKeyName: "exam_results_student_exam_id_fkey"
            columns: ["student_exam_id"]
            isOneToOne: true
            referencedRelation: "student_exams"
            referencedColumns: ["id"]
          },
        ]
      }
      exam_subjects: {
        Row: {
          exam_id: string
          subject_id: string
        }
        Insert: {
          exam_id: string
          subject_id: string
        }
        Update: {
          exam_id?: string
          subject_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "exam_subjects_exam_id_fkey"
            columns: ["exam_id"]
            isOneToOne: false
            referencedRelation: "exams"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "exam_subjects_subject_id_fkey"
            columns: ["subject_id"]
            isOneToOne: false
            referencedRelation: "subjects"
            referencedColumns: ["id"]
          },
        ]
      }
      exams: {
        Row: {
          created_at: string
          created_by: string | null
          description: string | null
          duration_minutes: number
          id: string
          instructions: string | null
          marks_per_correct: number
          negative_marking_ratio: number
          randomize_questions: boolean
          scheduled_date: string | null
          start_time: string | null
          status: Database["public"]["Enums"]["exam_status"]
          title: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          description?: string | null
          duration_minutes?: number
          id?: string
          instructions?: string | null
          marks_per_correct?: number
          negative_marking_ratio?: number
          randomize_questions?: boolean
          scheduled_date?: string | null
          start_time?: string | null
          status?: Database["public"]["Enums"]["exam_status"]
          title: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          description?: string | null
          duration_minutes?: number
          id?: string
          instructions?: string | null
          marks_per_correct?: number
          negative_marking_ratio?: number
          randomize_questions?: boolean
          scheduled_date?: string | null
          start_time?: string | null
          status?: Database["public"]["Enums"]["exam_status"]
          title?: string
          updated_at?: string
        }
        Relationships: []
      }
      login_attempts: {
        Row: {
          email: string
          failed_count: number
          locked_until: string | null
          updated_at: string
        }
        Insert: {
          email: string
          failed_count?: number
          locked_until?: string | null
          updated_at?: string
        }
        Update: {
          email?: string
          failed_count?: number
          locked_until?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      profiles: {
        Row: {
          created_at: string
          created_by: string | null
          email: string
          full_name: string
          id: string
          is_active: boolean
          last_login_at: string | null
          updated_at: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          email: string
          full_name: string
          id: string
          is_active?: boolean
          last_login_at?: string | null
          updated_at?: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          email?: string
          full_name?: string
          id?: string
          is_active?: boolean
          last_login_at?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      questions: {
        Row: {
          correct_option: Database["public"]["Enums"]["option_letter"]
          created_at: string
          created_by: string | null
          difficulty: Database["public"]["Enums"]["question_difficulty"]
          id: string
          marks: number
          negative_marks: number
          option_a: string
          option_a_image: string | null
          option_b: string
          option_b_image: string | null
          option_c: string
          option_c_image: string | null
          option_d: string
          option_d_image: string | null
          question_image: string | null
          question_text: string
          subject_id: string
          topic_tag: string | null
          updated_at: string
        }
        Insert: {
          correct_option: Database["public"]["Enums"]["option_letter"]
          created_at?: string
          created_by?: string | null
          difficulty?: Database["public"]["Enums"]["question_difficulty"]
          id?: string
          marks?: number
          negative_marks?: number
          option_a: string
          option_a_image?: string | null
          option_b: string
          option_b_image?: string | null
          option_c: string
          option_c_image?: string | null
          option_d: string
          option_d_image?: string | null
          question_image?: string | null
          question_text: string
          subject_id: string
          topic_tag?: string | null
          updated_at?: string
        }
        Update: {
          correct_option?: Database["public"]["Enums"]["option_letter"]
          created_at?: string
          created_by?: string | null
          difficulty?: Database["public"]["Enums"]["question_difficulty"]
          id?: string
          marks?: number
          negative_marks?: number
          option_a?: string
          option_a_image?: string | null
          option_b?: string
          option_b_image?: string | null
          option_c?: string
          option_c_image?: string | null
          option_d?: string
          option_d_image?: string | null
          question_image?: string | null
          question_text?: string
          subject_id?: string
          topic_tag?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "questions_subject_id_fkey"
            columns: ["subject_id"]
            isOneToOne: false
            referencedRelation: "subjects"
            referencedColumns: ["id"]
          },
        ]
      }
      solutions: {
        Row: {
          created_at: string
          id: string
          question_id: string
          solution_image: string | null
          solution_text: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          id?: string
          question_id: string
          solution_image?: string | null
          solution_text: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          id?: string
          question_id?: string
          solution_image?: string | null
          solution_text?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "solutions_question_id_fkey"
            columns: ["question_id"]
            isOneToOne: true
            referencedRelation: "questions"
            referencedColumns: ["id"]
          },
        ]
      }
      student_answers: {
        Row: {
          answered_at: string | null
          id: string
          is_marked_for_review: boolean
          question_id: string
          selected_option: Database["public"]["Enums"]["answer_letter"]
          student_exam_id: string
          time_spent_seconds: number
        }
        Insert: {
          answered_at?: string | null
          id?: string
          is_marked_for_review?: boolean
          question_id: string
          selected_option?: Database["public"]["Enums"]["answer_letter"]
          student_exam_id: string
          time_spent_seconds?: number
        }
        Update: {
          answered_at?: string | null
          id?: string
          is_marked_for_review?: boolean
          question_id?: string
          selected_option?: Database["public"]["Enums"]["answer_letter"]
          student_exam_id?: string
          time_spent_seconds?: number
        }
        Relationships: [
          {
            foreignKeyName: "student_answers_question_id_fkey"
            columns: ["question_id"]
            isOneToOne: false
            referencedRelation: "questions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "student_answers_student_exam_id_fkey"
            columns: ["student_exam_id"]
            isOneToOne: false
            referencedRelation: "student_exams"
            referencedColumns: ["id"]
          },
        ]
      }
      student_exams: {
        Row: {
          created_at: string
          exam_id: string
          id: string
          started_at: string | null
          status: Database["public"]["Enums"]["student_exam_status"]
          student_id: string
          submitted_at: string | null
          termination_reason: string | null
          total_score: number | null
        }
        Insert: {
          created_at?: string
          exam_id: string
          id?: string
          started_at?: string | null
          status?: Database["public"]["Enums"]["student_exam_status"]
          student_id: string
          submitted_at?: string | null
          termination_reason?: string | null
          total_score?: number | null
        }
        Update: {
          created_at?: string
          exam_id?: string
          id?: string
          started_at?: string | null
          status?: Database["public"]["Enums"]["student_exam_status"]
          student_id?: string
          submitted_at?: string | null
          termination_reason?: string | null
          total_score?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "student_exams_exam_id_fkey"
            columns: ["exam_id"]
            isOneToOne: false
            referencedRelation: "exams"
            referencedColumns: ["id"]
          },
        ]
      }
      subjects: {
        Row: {
          created_at: string
          id: string
          is_archived: boolean
          name: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          id?: string
          is_archived?: boolean
          name: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          id?: string
          is_archived?: boolean
          name?: string
          updated_at?: string
        }
        Relationships: []
      }
      user_roles: {
        Row: {
          created_at: string
          id: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          role?: Database["public"]["Enums"]["app_role"]
          user_id?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      get_user_role: {
        Args: { _user_id: string }
        Returns: Database["public"]["Enums"]["app_role"]
      }
      has_role: {
        Args: {
          _role: Database["public"]["Enums"]["app_role"]
          _user_id: string
        }
        Returns: boolean
      }
    }
    Enums: {
      answer_letter: "A" | "B" | "C" | "D" | "NONE"
      app_role: "PRINCIPAL" | "STUDENT"
      exam_status: "DRAFT" | "SCHEDULED" | "ONGOING" | "COMPLETED"
      option_letter: "A" | "B" | "C" | "D"
      question_difficulty: "Easy" | "Medium" | "Hard"
      student_exam_status:
        | "NOT_STARTED"
        | "ONGOING"
        | "SUBMITTED"
        | "TERMINATED"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      answer_letter: ["A", "B", "C", "D", "NONE"],
      app_role: ["PRINCIPAL", "STUDENT"],
      exam_status: ["DRAFT", "SCHEDULED", "ONGOING", "COMPLETED"],
      option_letter: ["A", "B", "C", "D"],
      question_difficulty: ["Easy", "Medium", "Hard"],
      student_exam_status: [
        "NOT_STARTED",
        "ONGOING",
        "SUBMITTED",
        "TERMINATED",
      ],
    },
  },
} as const
