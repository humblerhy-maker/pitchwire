create table if not exists pitch_prediction_runs (
  id text primary key,
  created_at text not null,
  mode text not null,
  request_text text not null,
  intent text not null,
  result text not null
);

create table if not exists pitch_predictions (
  id text primary key,
  run_id text not null,
  created_at text not null,
  sport text not null,
  competition text,
  event_key text not null,
  home_name text not null,
  away_name text not null,
  start_time text,
  market text not null,
  selection text not null,
  line double precision,
  bookmaker text,
  is_1xbet boolean not null,
  odds double precision,
  odds_received_at text,
  probability double precision,
  probability_label text,
  confidence text not null,
  evidence text not null,
  decision text not null,
  outcome text not null default 'pending',
  outcome_detail text,
  settled_at text
);

create table if not exists pitch_bookmarks (
  id text primary key,
  created_at text not null,
  prediction_id text,
  payload text not null
);
