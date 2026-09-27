// Packer configuration for building CloudGaming Hub Windows AMI
// Pre-installs: GPU drivers, Sunshine, Battle.net, and essential gaming software
// Build: packer build -var-file=vars.pkr.hcl windows-gaming-ami.pkr.hcl

packer {
  required_plugins {
    amazon = {
      source  = "github.com/hashicorp/amazon"
      version = "~> 1.2.0"
    }
  }
}

variable "aws_region" {
  type    = string
  default = "us-east-1"
}

variable "instance_type" {
  type    = string
  default = "g4dn.xlarge"
}

variable "base_ami_filter" {
  type = object({
    name  = list(string)
    owner = list(string)
  })
  default = {
    # Windows Server 2022 with Desktop Experience
    name  = ["Windows_Server-2022-English-Core-Base-*"]
    owner = ["amazon"]
  }
}

variable "ami_name" {
  type    = string
  default = "cloudgaming-gaming-ami-{{timestamp}}"
}

variable "ami_description" {
  type    = string
  default = "CloudGaming Hub Windows AMI with GPU drivers, Sunshine, and gaming clients pre-installed"
}

variable "root_volume_size" {
  type    = number
  default = 100  # 100GB for gaming libraries
}

variable "ebs_volume_type" {
  type    = string
  default = "gp3"
}

# Data source to find the latest Windows Server 2022 AMI
data "amazon-ami" "windows" {
  filters = {
    name                = var.base_ami_filter.name[0]
    root-device-type    = "ebs"
    virtualization-type = "hvm"
  }
  most_recent = true
  owners      = var.base_ami_filter.owner
  region      = var.aws_region
}

source "amazon-ebs" "cloudgaming_windows" {
  region        = var.aws_region
  source_ami    = data.amazon-ami.windows.id
  instance_type = var.instance_type
  ami_name      = var.ami_name
  ami_description = var.ami_description

  # Volume configuration
  root_volume_size      = var.root_volume_size
  ebs_optimized         = true
  root_volume_type      = var.ebs_volume_type

  # Allow large builds and GPU optimization
  ami_virtualization_type = "hvm"
  ebs_block_device_mappings {
    device_name           = "/dev/sda1"
    volume_size           = var.root_volume_size
    volume_type           = var.ebs_volume_type
    delete_on_termination = true
    encrypted             = true
    iops                  = 3000
    throughput            = 125
  }

  # Security & SSH
  security_group_source_cidr = "0.0.0.0/0"
  communicator              = "winrm"
  winrm_username            = "Administrator"
  winrm_port                = 5985
  winrm_timeout             = "30m"

  # Enable WinRM user data
  user_data_file = "${path.root}/enable-winrm.ps1"

  # Tags for tracking
  tags = {
    Name      = "CloudGaming-Gaming-AMI"
    Builder   = "Packer"
    CreatedBy = "CloudGaming Hub"
    Purpose   = "Gaming Instance Template"
  }

  # Snapshot on volume encryption
  encrypt_boot = true
}

build {
  name    = "cloudgaming-gaming-ami"
  sources = ["source.amazon-ebs.cloudgaming_windows"]

  # Wait for Windows to stabilize
  provisioner "windows-shell" {
    inline = [
      "echo Waiting for system initialization...",
      "timeout /t 60",
      "systeminfo"
    ]
  }

  # Install Windows updates
  provisioner "windows-shell" {
    script = "${path.root}/scripts/01-windows-updates.ps1"
    pause_before = "30s"
  }

  # Install NVIDIA GPU drivers
  provisioner "windows-shell" {
    script = "${path.root}/scripts/02-install-nvidia-drivers.ps1"
  }

  # Install CloudyPad (which includes Sunshine)
  provisioner "windows-shell" {
    script = "${path.root}/scripts/03-install-cloudypad.ps1"
  }

  # Install gaming clients
  provisioner "windows-shell" {
    script = "${path.root}/scripts/04-install-gaming-clients.ps1"
  }

  # Configure Sunshine auto-start
  provisioner "windows-shell" {
    script = "${path.root}/scripts/05-configure-sunshine.ps1"
  }

  # Install CloudGaming monitoring agent
  provisioner "windows-shell" {
    script = "${path.root}/scripts/06-install-monitoring-agent.ps1"
  }

  # Cleanup and optimization
  provisioner "windows-shell" {
    script = "${path.root}/scripts/07-cleanup-optimize.ps1"
  }

  # Final verification
  provisioner "windows-shell" {
    inline = [
      "powershell -Command \"",
      "  Write-Host 'AMI Build Verification'",
      "  Write-Host ('GPU Status: ' + (Get-WmiObject -Class Win32_VideoController).Name)",
      "  Write-Host ('Sunshine Version: ' + (Get-Item -Path 'C:\\Program Files\\Sunshine\\' -ErrorAction SilentlyContinue).VersionInfo.ProductVersion)",
      "  Write-Host 'Build complete - AMI ready for CloudGaming Hub'",
      "\""
    ]
  }
}

output "ami_id" {
  description = "The ID of the generated AMI"
  value       = data.amazon-ebs.cloudgaming_windows.id
}

output "ami_name" {
  description = "The name of the generated AMI"
  value       = var.ami_name
}
