const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ERROR_CODE_PATTERN = /^[a-z0-9][a-z0-9_.:-]{0,99}$/;

function requiredText(value, name, maxLength = 200) {
  if (typeof value !== 'string' || !value.trim() || value.length > maxLength) {
    throw new TypeError(`${name} must be a non-empty string up to ${maxLength} characters`);
  }
  return value.trim();
}

function uuid(value, name) {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new TypeError(`${name} must be a UUID`);
  }
  return value;
}

function integer(value, name, minimum, maximum) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function optionalTimestamp(value, name) {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError(`${name} must be a valid timestamp`);
  return date;
}

export function createJobsRepository({ pool, withOwnedBusinessContext }) {
  if (!pool?.query || typeof withOwnedBusinessContext !== 'function') {
    throw new TypeError('jobs repository requires pool and withOwnedBusinessContext');
  }

  async function enqueueJob(userId, {
    storeId,
    jobType,
    deduplicationKey,
    payload = {},
    availableAt = null,
    priority = 0,
    maxAttempts = 5
  }) {
    uuid(storeId, 'storeId');
    jobType = requiredText(jobType, 'jobType', 100);
    deduplicationKey = requiredText(deduplicationKey, 'deduplicationKey', 300);
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new TypeError('payload must be a JSON object');
    }
    const encodedPayload = JSON.stringify(payload);
    if (Buffer.byteLength(encodedPayload, 'utf8') > 262144) {
      throw new TypeError('payload must not exceed 256 KiB');
    }
    availableAt = optionalTimestamp(availableAt, 'availableAt');
    priority = integer(priority, 'priority', -1000, 1000);
    maxAttempts = integer(maxAttempts, 'maxAttempts', 1, 100);

    return withOwnedBusinessContext(userId, async client => (await client.query(
      `select * from mc.enqueue_job($1,$2,$3,$4::jsonb,$5,$6,$7)`,
      [storeId, jobType, deduplicationKey, encodedPayload, availableAt, priority, maxAttempts]
    )).rows[0]);
  }

  async function claimJobs({ workerId, jobTypes, leaseSeconds = 60, limit = 1 }) {
    workerId = requiredText(workerId, 'workerId', 200);
    if (!Array.isArray(jobTypes) || jobTypes.length === 0) {
      throw new TypeError('jobTypes must be a non-empty array');
    }
    jobTypes = [...new Set(jobTypes.map(value => requiredText(value, 'jobType', 100)))];
    if (jobTypes.length > 50) throw new TypeError('jobTypes must contain at most 50 values');
    leaseSeconds = integer(leaseSeconds, 'leaseSeconds', 5, 3600);
    limit = integer(limit, 'limit', 1, 100);
    return (await pool.query(
      `select * from mc.claim_jobs($1,$2::text[],$3,$4)`,
      [workerId, jobTypes, leaseSeconds, limit]
    )).rows;
  }

  async function heartbeatJob({ jobId, leaseToken, workerId, leaseSeconds = 60 }) {
    uuid(jobId, 'jobId');
    uuid(leaseToken, 'leaseToken');
    workerId = requiredText(workerId, 'workerId', 200);
    leaseSeconds = integer(leaseSeconds, 'leaseSeconds', 5, 3600);
    return Boolean((await pool.query(
      `select (mc.heartbeat_job($1,$2,$3,$4)).id is not null as accepted`,
      [jobId, leaseToken, workerId, leaseSeconds]
    )).rows[0]?.accepted);
  }

  async function completeJob({ jobId, leaseToken, workerId, outcome = 'completed' }) {
    uuid(jobId, 'jobId');
    uuid(leaseToken, 'leaseToken');
    workerId = requiredText(workerId, 'workerId', 200);
    if (!['completed', 'superseded'].includes(outcome)) {
      throw new TypeError('outcome must be completed or superseded');
    }
    return Boolean((await pool.query(
      `select (mc.complete_job($1,$2,$3,$4)).id is not null as accepted`,
      [jobId, leaseToken, workerId, outcome]
    )).rows[0]?.accepted);
  }

  async function failJob({
    jobId,
    leaseToken,
    workerId,
    errorCode,
    retryable = true,
    retryDelaySeconds = 60
  }) {
    uuid(jobId, 'jobId');
    uuid(leaseToken, 'leaseToken');
    workerId = requiredText(workerId, 'workerId', 200);
    if (typeof errorCode !== 'string' || !ERROR_CODE_PATTERN.test(errorCode)) {
      throw new TypeError('errorCode must be a safe machine-readable code');
    }
    if (typeof retryable !== 'boolean') throw new TypeError('retryable must be boolean');
    retryDelaySeconds = integer(retryDelaySeconds, 'retryDelaySeconds', 0, 86400);
    return (await pool.query(
      `select * from mc.fail_job($1,$2,$3,$4,$5,$6)`,
      [jobId, leaseToken, workerId, errorCode, retryable, retryDelaySeconds]
    )).rows[0] ?? null;
  }

  return { enqueueJob, claimJobs, heartbeatJob, completeJob, failJob };
}
