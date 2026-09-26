CREATE TABLE IF NOT EXISTS viero_agent_runs (
  id uuid PRIMARY KEY,
  started_at timestamptz NOT NULL,
  mode text NOT NULL CHECK (mode IN ('live-readonly', 'live-execution', 'replay')),
  status text NOT NULL CHECK (status IN ('ok', 'degraded', 'failed')),
  payload jsonb NOT NULL
);
ALTER TABLE viero_agent_runs ADD COLUMN IF NOT EXISTS recorded_at timestamptz NOT NULL DEFAULT clock_timestamp();
CREATE TABLE IF NOT EXISTS viero_observations (
  run_id uuid NOT NULL REFERENCES viero_agent_runs(id),
  chain_id integer NOT NULL CHECK (chain_id IN (4663,56,8453,5042)),
  protocol text NOT NULL CHECK (protocol IN ('v3','v4')),
  dex_id text NOT NULL CHECK (dex_id IN ('uniswap','pancakeswap')),
  pool_id text NOT NULL,
  source_block numeric(78,0) NOT NULL,
  window_end timestamptz NOT NULL,
  payload jsonb NOT NULL,
  PRIMARY KEY(run_id,chain_id,protocol,dex_id,pool_id),
  CHECK (dex_id <> 'pancakeswap' OR (chain_id = 56 AND protocol = 'v3'))
);
CREATE INDEX IF NOT EXISTS viero_pool_history ON viero_observations(chain_id,protocol,dex_id,pool_id,window_end DESC);
CREATE TABLE IF NOT EXISTS viero_decisions (
  run_id uuid NOT NULL REFERENCES viero_agent_runs(id),
  chain_id integer NOT NULL CHECK (chain_id IN (4663,56,8453,5042)),
  pool_identity text NOT NULL,
  approved boolean NOT NULL,
  payload jsonb NOT NULL,
  PRIMARY KEY(run_id,chain_id,pool_identity)
);
CREATE TABLE IF NOT EXISTS viero_controls (
  id integer PRIMARY KEY CHECK (id = 1),
  payload jsonb NOT NULL
);
CREATE TABLE IF NOT EXISTS viero_strategy_state (
  id integer PRIMARY KEY CHECK (id = 1),
  payload jsonb NOT NULL
);
