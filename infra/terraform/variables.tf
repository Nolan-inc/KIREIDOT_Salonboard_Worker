variable "region" {
  type    = string
  default = "ap-northeast-1"
}

variable "name" {
  description = "リソース名プレフィックス"
  type        = string
  default     = "kireidot-sb"
}

variable "vpc_cidr" {
  type    = string
  default = "10.80.0.0/16"
}

variable "kireidot_api_url" {
  description = "KireidotAdmin の API ベース URL (例: https://admin.kireidot.jp)。worker Service を動かす Phase 1 までに実値へ更新すること (カナリアは未使用)"
  type        = string
  default     = "https://CHANGE-ME.invalid"
}

variable "poll_interval_ms" {
  type    = number
  default = 15000
}

variable "spare_eip_count" {
  description = "Tier3 IP ローテーション用の予備 EIP 数 (NAT GW 付け替え用)"
  type        = number
  default     = 2
}

variable "worker_cpu" {
  type    = number
  default = 1024
}

variable "worker_memory" {
  type    = number
  default = 2048
}

variable "service_desired_count" {
  description = "ECS Service の希望タスク数。Phase 0 カナリアでは 0 のまま run-task で手動起動する"
  type        = number
  default     = 0
}

variable "service_max_count" {
  description = "scaling Lambda が引き上げてよい上限 (SalonBoard 同時セッション挙動の実測まで保守的に)"
  type        = number
  default     = 5
}

variable "github_repo" {
  description = "GitHub OIDC デプロイを許可するリポジトリ (owner/repo)"
  type        = string
  default     = "Nolan-inc/KIREIDOT_Salonboard_Worker"
}

variable "enable_push" {
  description = "SALONBOARD_ENABLE_PUSH。クラウドからの登録ボタン押下は Phase 0/1 では必ず false"
  type        = bool
  default     = false
}
