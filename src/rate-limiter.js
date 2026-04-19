'use strict';

class TokenBucketRateLimiter {
	constructor(opts = {}) {
		this.tokensPerSecond = opts.tokensPerSecond ?? 1.5;
		this.maxBurst = opts.maxBurst ?? 4;
		this.tokens = this.maxBurst;
		this.lastRefill = Date.now();
		this._queue = [];
		this._processing = false;
	}

	_refill() {
		const now = Date.now();
		const elapsed = (now - this.lastRefill) / 1000;
		this.tokens = Math.min(this.maxBurst, this.tokens + elapsed * this.tokensPerSecond);
		this.lastRefill = now;
	}

	acquire(cost = 1) {
		return new Promise(resolve => {
			this._queue.push({
				cost,
				resolve
			});
			this._drain();
		});
	}

	_drain() {
		if (this._processing) return;
		this._processing = true;
		const tick = () => {
			this._refill();
			while (this._queue.length > 0) {
				const {
					cost,
					resolve
				} = this._queue[0];
				if (this.tokens >= cost) {
					this.tokens -= cost;
					this._queue.shift();
					resolve();
				} else {
					const waitMs = Math.ceil(((cost - this.tokens) / this.tokensPerSecond) * 1000);
					setTimeout(tick, waitMs);
					return;
				}
			}
			this._processing = false;
		};
		tick();
	}
}

class ConcurrencyLimiter {
	constructor(limit = 2) {
		this.limit = limit;
		this.active = 0;
		this._queue = [];
	}

	run(fn) {
		return new Promise((resolve, reject) => {
			this._queue.push({
				fn,
				resolve,
				reject
			});
			this._schedule();
		});
	}

	_schedule() {
		while (this.active < this.limit && this._queue.length > 0) {
			const {
				fn,
				resolve,
				reject
			} = this._queue.shift();
			this.active++;
			Promise.resolve().then(fn).then(resolve, reject).finally(() => {
				this.active--;
				this._schedule();
			});
		}
	}
}

class RetryPolicy {
	constructor(opts = {}) {
		this.maxRetries = opts.maxRetries ?? 3;
		this.baseDelayMs = opts.baseDelayMs ?? 800;
		this.maxDelayMs = opts.maxDelayMs ?? 10000;
		this.jitter = opts.jitter ?? true;
		this.retryOn = opts.retryOn ?? [429, 500, 502, 503, 504];
	}

	shouldRetry(error, attempt) {
		if (attempt >= this.maxRetries) return false;
		if (error?.status && this.retryOn.includes(error.status)) return true;
		if (error?.code === 'ECONNRESET' || error?.code === 'ENOTFOUND') return true;
		return false;
	}

	delay(attempt) {
		const exp = Math.min(this.baseDelayMs * Math.pow(2, attempt), this.maxDelayMs);
		const noise = this.jitter ? Math.random() * this.baseDelayMs : 0;
		return exp + noise;
	}
}

async function withRetry(fn, policy) {
	const rp = policy instanceof RetryPolicy ? policy : new RetryPolicy(policy);
	let lastError;
	for (let attempt = 0; attempt <= rp.maxRetries; attempt++) {
		try {
			return await fn();
		} catch (err) {
			lastError = err;
			if (!rp.shouldRetry(err, attempt)) throw err;
			await new Promise(r => setTimeout(r, rp.delay(attempt)));
		}
	}
	throw lastError;
}

module.exports = {
	TokenBucketRateLimiter,
	ConcurrencyLimiter,
	RetryPolicy,
	withRetry
};