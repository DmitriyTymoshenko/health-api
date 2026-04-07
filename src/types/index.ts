import { ObjectId } from 'mongodb'

export interface NutritionEntry {
  _id?: ObjectId
  date: string
  meal_type: 'breakfast' | 'lunch' | 'dinner' | 'snack'
  food_name?: string
  name?: string
  kcal: number
  protein_g: number
  fat_g: number
  carbs_g: number
  fiber_g?: number
  amount_g?: number
  created_at?: Date
}

// Raw input — accepts both protein and protein_g
export interface NutritionInput {
  date?: string
  meal_type: string
  food_name?: string
  name?: string
  kcal: number
  protein_g?: number
  fat_g?: number
  carbs_g?: number
  protein?: number
  fat?: number
  carbs?: number
  fiber_g?: number
  amount_g?: number
}

export interface WeightEntry {
  _id?: ObjectId
  date: string
  weight_kg: number
  note?: string
  created_at?: Date
}

export interface WaterEntry {
  _id?: ObjectId
  date: string
  amount_ml: number
  source?: string
  created_at?: Date
}

export interface StepsEntry {
  _id?: ObjectId
  date: string
  steps: number
  source?: string
  created_at?: Date
}

export interface SupplementCatalog {
  id: number
  name: string
  short_name?: string
  brand?: string
  dose: string
  schedule: 'morning' | 'pre_meal' | 'pre_workout' | 'evening'
  notes?: string
  active?: boolean
  composition?: Record<string, unknown>
  coverage_gaps?: Array<{ nutrient: string; reason: string; recommend_extra?: string }>
  covers?: string[]
}

export interface SupplementCycle {
  id: number
  supplement_id: number
  supplement_name?: string
  start_date: string
  duration_weeks: number
  pause_weeks: number
  status: 'active' | 'paused' | 'completed'
  notes?: string
}

export interface SupplementIntake {
  _id?: ObjectId
  supplement_id: number
  date: string
  taken_at?: string
}

export interface SupplementKnowledge {
  catalog_id: number
  name: string
  active_ingredients: Array<{
    name: string
    amount_per_dose: number | null
    unit: string
    note?: string
  }>
  covers: string[]
  coverage_gaps?: Array<{ nutrient: string; reason: string; recommend_extra?: string }>
  notes?: string
}

export interface LabResult {
  _id?: ObjectId
  date: string
  values: Record<string, number>
  source: 'manual' | 'pdf'
  notes?: string
  filename?: string
  created_at?: Date
}

export interface DailyMetrics {
  _id?: ObjectId
  date: string
  recovery_score: number
  hrv: number
  resting_hr: number
  strain: number
  sleep_performance: number
  sleep_stages?: {
    light?: number
    deep?: number
    rem?: number
  }
  spo2?: number
  skin_temp?: number
  calories_burned?: number
  source?: string
  created_at?: Date
}

export interface Workout {
  _id?: ObjectId
  date: string
  type: string
  duration_min?: number
  strain?: number
  notes?: string
  exercises?: unknown[]
  created_at?: Date
}

export interface UserSettings {
  key: string
  daily_deficit_goal?: number
  weight_start?: number
  weight_goal_near?: number
  name?: string
  height_cm?: number
  birth_year?: number
  weight_milestones?: Array<{ date: string; target: number; label: string }>
}

export interface PRRecord {
  value: number
  date: string | null
  weight?: number | null
  reps?: number | null
}

export interface PersonalRecord {
  exercise: string
  muscle_group: string | null
  max_weight: PRRecord
  max_volume: PRRecord
  max_1rm: PRRecord
  max_reps: PRRecord
  total_sessions: number
  history?: Array<{
    date: string
    est_1rm: number
    max_weight: number
    volume: number
  }>
}

export interface NewPRDetection {
  exercise: string
  records: Array<{
    type: 'max_weight' | 'max_volume' | 'max_1rm' | 'max_reps'
    value: number
    previous: number
    weight?: number
    reps?: number
  }>
}

export interface PRSummary {
  total_exercises_tracked: number
  total_workout_sessions: number
  top_5_by_1rm: PersonalRecord[]
  recent_prs: Array<{
    exercise: string
    muscle_group: string | null
    total_sessions: number
    recent_prs: Partial<Record<string, PRRecord>>
  }>
  period_days: number
}

export interface ApiError {
  error: string
  details?: unknown
}
