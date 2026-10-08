create table if not exists pitch_providers (
  provider_id text primary key,
  capabilities text not null,
  updated_at text not null
);

create table if not exists pitch_teams (
  team_key text primary key,
  name text not null
);

create table if not exists pitch_matches (
  match_id text primary key,
  home_team text not null,
  away_team text not null,
  competition text,
  kickoff text,
  updated_at text not null
);

create table if not exists pitch_provider_events (
  event_id text primary key,
  provider text not null,
  match_id text,
  raw_payload text not null,
  provider_timestamp text,
  received_at text not null,
  normalized text,
  processing_ms double precision,
  published_at text
);

create table if not exists pitch_events (
  event_id text primary key,
  provider text not null,
  match_id text not null,
  event_type text not null,
  payload text not null,
  received_at text not null,
  published_at text
);

create table if not exists pitch_observations (
  id text primary key,
  match_id text not null,
  provider text not null,
  event_type text not null,
  score text,
  received_at text not null,
  provider_timestamp text,
  duplicate boolean not null
);

create table if not exists pitch_latency (
  id text primary key,
  kind text not null,
  provider text,
  ms double precision not null,
  recorded_at text not null
);

create table if not exists pitch_provider_health (
  provider text primary key,
  status text not null,
  detail text,
  updated_at text not null,
  failures integer not null,
  events_received integer not null
);

create table if not exists pitch_match_snapshots (
  id text primary key,
  match_id text not null,
  payload text not null,
  taken_at text not null
);
