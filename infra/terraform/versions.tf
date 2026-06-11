terraform {
  required_version = ">= 1.7"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.80"
    }
  }

  # 運用に乗せる際は S3 backend に切り替えること
  # backend "s3" { ... }
}

provider "aws" {
  region = var.region

  default_tags {
    tags = {
      Project   = "kireidot-salonboard-worker"
      ManagedBy = "terraform"
    }
  }
}
