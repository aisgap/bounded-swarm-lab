declare namespace Cloudflare {
  interface Env {
    DB?: D1Database;
    BUCKET?: R2Bucket;
    OPENAI_API_KEY?: string;
    SWARM_AUTHORIZED_MICROUSD?: string;
    SWARM_LIVE_ENABLED?: string;
    SWARM_MODEL?: string;
    SWARM_START_THRESHOLD_MICROUSD?: string;
  }
}
