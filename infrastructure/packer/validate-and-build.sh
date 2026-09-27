#!/bin/bash
# CloudGaming Hub Packer AMI Build Script
# Builds Windows Server 2022 AMI with gaming infrastructure for AWS Singapore
# Requirements: packer, aws-cli, AWS credentials configured

set -e  # Exit on error

echo "╔════════════════════════════════════════════════════════════════╗"
echo "║     CloudGaming Hub - Custom Gaming AMI Build Script           ║"
echo "║     Region: AWS Singapore (ap-southeast-1)                    ║"
echo "║     Instance: g4dn.xlarge (NVIDIA T4 GPU)                     ║"
echo "╚════════════════════════════════════════════════════════════════╝"
echo ""

# Color codes
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

# Check prerequisites
echo "📋 Checking prerequisites..."

# Check Packer
if ! command -v packer &> /dev/null; then
    echo -e "${RED}✗ Packer not found${NC}"
    echo "  Install: brew install packer"
    echo "  Or: https://www.packer.io/downloads"
    exit 1
fi
PACKER_VERSION=$(packer version | grep Packer | awk '{print $2}')
echo -e "${GREEN}✓ Packer ${PACKER_VERSION}${NC}"

# Check AWS CLI
if ! command -v aws &> /dev/null; then
    echo -e "${RED}✗ AWS CLI not found${NC}"
    echo "  Install: brew install awscli"
    exit 1
fi
echo -e "${GREEN}✓ AWS CLI installed${NC}"

# Check AWS credentials
if ! aws sts get-caller-identity &> /dev/null; then
    echo -e "${RED}✗ AWS credentials not configured${NC}"
    echo "  Run: aws configure"
    exit 1
fi
AWS_ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
echo -e "${GREEN}✓ AWS Account: $AWS_ACCOUNT${NC}"

# Check SSH key in Singapore region
echo ""
echo "🔑 Checking SSH key in ap-southeast-1..."
if aws ec2 describe-key-pairs --region ap-southeast-1 --query 'KeyPairs[?KeyName==`cloudgaming-key`]' --output text 2>/dev/null | grep -q cloudgaming-key; then
    echo -e "${GREEN}✓ SSH key 'cloudgaming-key' exists in Singapore${NC}"
else
    echo -e "${YELLOW}⚠ SSH key 'cloudgaming-key' not found in Singapore${NC}"
    echo "  Creating new key pair..."
    aws ec2 create-key-pair \
        --key-name cloudgaming-key \
        --region ap-southeast-1 \
        --query 'KeyMaterial' \
        --output text > ~/.ssh/cloudgaming-key.pem 2>&1
    chmod 600 ~/.ssh/cloudgaming-key.pem
    echo -e "${GREEN}✓ Created and saved to ~/.ssh/cloudgaming-key.pem${NC}"
fi

# Validate Packer configuration
echo ""
echo "🔍 Validating Packer configuration..."
if packer validate -var-file=vars.pkr.hcl windows-gaming-ami.pkr.hcl; then
    echo -e "${GREEN}✓ Configuration is valid${NC}"
else
    echo -e "${RED}✗ Configuration validation failed${NC}"
    exit 1
fi

# Show build parameters
echo ""
echo "📦 Build Parameters:"
echo "  Region: ap-southeast-1 (Singapore)"
echo "  Instance Type: g4dn.xlarge"
echo "  Root Volume: 100GB (gp3)"
echo "  Estimated Time: 25-30 minutes"
echo "  Estimated Cost: ~$0.30"
echo ""

# Confirm before building
echo -e "${YELLOW}Ready to build custom gaming AMI?${NC}"
read -p "Type 'yes' to proceed: " confirm

if [ "$confirm" != "yes" ]; then
    echo "Build cancelled."
    exit 0
fi

# Start build
echo ""
echo "🚀 Starting Packer build..."
echo "   Timestamp: $(date)"
echo ""

packer build \
    -var-file=vars.pkr.hcl \
    windows-gaming-ami.pkr.hcl

BUILD_STATUS=$?

echo ""
echo "╔════════════════════════════════════════════════════════════════╗"

if [ $BUILD_STATUS -eq 0 ]; then
    echo -e "${GREEN}✓ Build completed successfully!${NC}"
    echo "╚════════════════════════════════════════════════════════════════╝"
    echo ""

    # Extract AMI ID from AWS
    echo "📸 Retrieving new AMI..."
    AMI_ID=$(aws ec2 describe-images \
        --region ap-southeast-1 \
        --owners self \
        --query 'Images | sort_by(@, &CreationDate) | [-1].[ImageId]' \
        --output text)

    echo -e "${GREEN}New AMI ID: $AMI_ID${NC}"
    echo ""
    echo "📝 Next steps:"
    echo "  1. Update backend: src/services/MachineService.ts"
    echo "     Set imageId: '$AMI_ID'"
    echo ""
    echo "  2. Or set environment variable:"
    echo "     export CLOUDGAMING_AMI_ID=$AMI_ID"
    echo ""
    echo "  3. Test instance launch:"
    echo "     curl -X POST http://localhost:3001/api/machines \\"
    echo "       -H 'Content-Type: application/json' \\"
    echo "       -d '{\"provider\":\"aws\",\"region\":\"ap-southeast-1\",\"instanceType\":\"g4dn.xlarge\"}'"
    echo ""
    echo "  4. Connect to Sunshine Web UI:"
    echo "     http://<instance-ip>:47990"
    echo ""

    # Save AMI ID
    echo "$AMI_ID" > .ami-id
    echo -e "${GREEN}✓ AMI ID saved to .ami-id${NC}"
else
    echo -e "${RED}✗ Build failed${NC}"
    echo "╚════════════════════════════════════════════════════════════════╝"
    echo ""
    echo "Check error messages above. Common issues:"
    echo "  - WinRM timeout: Increase winrm_timeout in packer config"
    echo "  - No capacity: Try different instance type"
    echo "  - Driver error: Check NVIDIA driver URL is accessible"
    echo ""
    exit 1
fi
