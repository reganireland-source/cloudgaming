-- Users table
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  budget_cap DECIMAL(10, 2),
  budget_alert_threshold DECIMAL(10, 2) DEFAULT 80.0,
  location_lat DECIMAL(9, 6),
  location_lng DECIMAL(9, 6)
);

-- Cloud credentials (encrypted)
CREATE TABLE IF NOT EXISTS cloud_credentials (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider VARCHAR(20) NOT NULL,
  encrypted_data TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, provider)
);

-- Machines
CREATE TABLE IF NOT EXISTS machines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider VARCHAR(20) NOT NULL,
  region VARCHAR(50) NOT NULL,
  instance_type VARCHAR(50) NOT NULL,
  instance_id VARCHAR(255) NOT NULL,
  status VARCHAR(20) DEFAULT 'stopped',
  cost_per_hour DECIMAL(8, 4),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  last_started TIMESTAMP,
  snapshot_id UUID REFERENCES snapshots(id),
  UNIQUE(provider, instance_id)
);

-- Snapshots (game library backups)
CREATE TABLE IF NOT EXISTS snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  machine_id UUID REFERENCES machines(id) ON DELETE SET NULL,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider VARCHAR(20) NOT NULL,
  region VARCHAR(50) NOT NULL,
  snapshot_provider_id VARCHAR(255) NOT NULL,
  disk_size_gb INTEGER,
  cost_per_month DECIMAL(8, 4),
  tags TEXT[] DEFAULT '{}',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(provider, snapshot_provider_id)
);

-- Cost tracking
CREATE TABLE IF NOT EXISTS costs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  machine_id UUID REFERENCES machines(id) ON DELETE SET NULL,
  date DATE NOT NULL,
  compute_cost DECIMAL(8, 4) DEFAULT 0,
  egress_cost DECIMAL(8, 4) DEFAULT 0,
  storage_cost DECIMAL(8, 4) DEFAULT 0,
  provider VARCHAR(20) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) PARTITION BY RANGE (date);

-- Game profiles (maintained by admin, visible to all users)
CREATE TABLE IF NOT EXISTS game_profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title VARCHAR(255) NOT NULL UNIQUE,
  gpu_class VARCHAR(20) NOT NULL,
  target_quality VARCHAR(50) NOT NULL,
  gpu_vram_gb INTEGER NOT NULL,
  cpu_vram_gb INTEGER NOT NULL,
  fps_cpu_bound BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Streaming quality tiers (reference data)
CREATE TABLE IF NOT EXISTS streaming_qualities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(50) NOT NULL,
  resolution VARCHAR(20) NOT NULL,
  fps INTEGER NOT NULL,
  bitrate_kbps INTEGER NOT NULL,
  codec VARCHAR(10) NOT NULL,
  gb_per_hour DECIMAL(5, 2) NOT NULL
);

-- Region pricing data (synced hourly from cloud provider APIs)
CREATE TABLE IF NOT EXISTS region_data (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider VARCHAR(20) NOT NULL,
  name VARCHAR(255) NOT NULL,
  region VARCHAR(50) NOT NULL,
  lat DECIMAL(9, 6),
  lng DECIMAL(9, 6),
  spot_price DECIMAL(8, 4),
  on_demand_price DECIMAL(8, 4),
  egress_cost_per_gb DECIMAL(6, 4),
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(provider, region)
);

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_machines_user_id ON machines(user_id);
CREATE INDEX IF NOT EXISTS idx_machines_provider_instance ON machines(provider, instance_id);
CREATE INDEX IF NOT EXISTS idx_costs_user_id_date ON costs(user_id, date);
CREATE INDEX IF NOT EXISTS idx_snapshots_user_id ON snapshots(user_id);
CREATE INDEX IF NOT EXISTS idx_cloud_credentials_user_id ON cloud_credentials(user_id);

-- Seed game profiles
INSERT INTO game_profiles (title, gpu_class, target_quality, gpu_vram_gb, cpu_vram_gb, fps_cpu_bound)
VALUES
  ('Valorant', 't4', '1440p-240', 2, 8, true),
  ('Elden Ring', 'a10g', '1440p-60', 24, 16, false),
  ('Baldur''s Gate 3', 'a100', '4K-60', 40, 32, false),
  ('Minecraft', 't4', '1080p-60', 2, 8, true)
ON CONFLICT DO NOTHING;

-- Seed streaming qualities
INSERT INTO streaming_qualities (name, resolution, fps, bitrate_kbps, codec, gb_per_hour)
VALUES
  ('Budget', '720p', 30, 3000, 'h264', 1.35),
  ('Good', '1080p', 60, 8000, 'h265', 3.60),
  ('High', '1440p', 60, 12000, 'h265', 5.40),
  ('Ultra', '4K', 60, 20000, 'h265', 9.00)
ON CONFLICT DO NOTHING;

-- Performance metrics (real-time monitoring)
CREATE TABLE IF NOT EXISTS performance_metrics (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  machine_id UUID NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
  timestamp TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  cpu_usage DECIMAL(5, 2) NOT NULL,
  gpu_usage DECIMAL(5, 2) NOT NULL,
  gpu_memory_usage INTEGER NOT NULL,
  gpu_memory_total INTEGER NOT NULL,
  network_bandwidth_up DECIMAL(10, 2) NOT NULL,
  network_bandwidth_down DECIMAL(10, 2) NOT NULL,
  network_packet_loss DECIMAL(5, 2) NOT NULL,
  network_latency DECIMAL(10, 2) NOT NULL,
  streaming_fps DECIMAL(5, 2) NOT NULL,
  streaming_frame_drops INTEGER NOT NULL DEFAULT 0,
  disk_read_iops INTEGER NOT NULL,
  disk_write_iops INTEGER NOT NULL,
  disk_read_mbps DECIMAL(10, 2) NOT NULL,
  disk_write_mbps DECIMAL(10, 2) NOT NULL,
  memory_usage INTEGER NOT NULL,
  memory_total INTEGER NOT NULL,
  gpu_temperature DECIMAL(5, 2) NOT NULL,
  cpu_temperature DECIMAL(5, 2) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Create indexes for performance metrics
CREATE INDEX IF NOT EXISTS idx_performance_metrics_machine_id_timestamp ON performance_metrics(machine_id, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_performance_metrics_timestamp ON performance_metrics(timestamp DESC);
