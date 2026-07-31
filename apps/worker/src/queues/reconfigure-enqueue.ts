// The `reconfigure-profile` producer now lives in @app/core/queue so apps/api's
// mutation routes share the exact enqueue (job name + payload + opts) instead of
// hand-rolling queue.add. Re-exported here so the worker's boot wiring and
// discovery.cron keep importing from this path.
export {
  createReconfigureEnqueue,
  RECONFIGURE_PROFILE_JOB_OPTS,
  type ReconfigureProfileRequest,
} from '@app/core/queue';
