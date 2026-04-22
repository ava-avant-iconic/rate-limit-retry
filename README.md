# Rate Limit Retry

A robust TypeScript library for combining rate limiting with exponential backoff, retry strategies, and circuit breaker patterns for production services.

## Features

- 🚦 **Rate Limiting** - Sliding window rate limiting with pluggable storage backends
- 🔄 **Retry Logic** - Configurable retry strategies (fixed, exponential, linear, custom)
- ⚡ **Circuit Breaker** - Prevent cascading failures with automatic recovery
- 🔌 **Flexible Storage** - In-memory storage included, extensible to Redis and others
- 📊 **Metrics & Callbacks** - Track state changes and retry attempts
- 🎯 **TypeScript** - Full type safety with strict mode
- ✅ **Well-Tested** - Comprehensive test coverage

## Installation

```bash
npm install rate-limit-retry
```

## Quick Start

```typescript
import { createManager } from 'rate-limit-retry';

// Create a manager with default settings
const manager = createManager({
  maxRequests: 100,
  windowMs: 60000,
}, {
  maxAttempts: 3,
  initialDelayMs: 1000,
  strategy: 'exponential-with-jitter',
}, {
  failureThreshold: 5,
  resetTimeoutMs: 60000,
});

// Execute a function with full protection
async function myApiCall() {
  const response = await fetch('https://api.example.com/data');
  return response.json();
}

const result = await manager.execute(myApiCall);

if (result.success) {
  console.log('Success!', result.result);
} else {
  console.error('Failed:', result.error);
  console.log('Attempts:', result.attempts);
}
```

## Components

### Rate Limiter

Control request frequency with sliding window rate limiting:

```typescript
import { createRateLimiter } from 'rate-limit-retry';

const limiter = createRateLimiter({
  maxRequests: 10,
  windowMs: 60000, // 1 minute
  keyGenerator: (context) => context.userId, // Group by user
});

const result = await limiter.check({ userId: 'user123' });

if (result.allowed) {
  // Process request
} else {
  // Rate limit exceeded
  console.log(`Try again in ${result.resetTimeMs}ms`);
}
```

### Retry Handler

Automatically retry failed operations with backoff:

```typescript
import { createRetryHandler } from 'rate-limit-retry';

const retry = createRetryHandler({
  maxAttempts: 5,
  initialDelayMs: 1000,
  maxDelayMs: 30000,
  strategy: 'exponential-with-jitter',
  isRetryable: (error) => {
    // Only retry on 5xx errors
    return error.message.includes('500');
  },
  onRetry: (attempt, error, delay) => {
    console.log(`Attempt ${attempt} failed. Retrying in ${delay}ms...`);
  },
});

const result = await retry.execute(async () => {
  return await fetch('https://api.example.com/data');
});
```

### Circuit Breaker

Prevent cascading failures when a service is down:

```typescript
import { createCircuitBreaker } from 'rate-limit-retry';

const breaker = createCircuitBreaker({
  failureThreshold: 5,
  resetTimeoutMs: 60000, // Try again after 1 minute
  successThreshold: 2,
  onStateChange: (from, to) => {
    console.log(`Circuit breaker: ${from} -> ${to}`);
  },
});

try {
  const result = await breaker.execute(async () => {
    return await fetch('https://api.example.com/data');
  });
} catch (error) {
  if (breaker.getState() === 'OPEN') {
    console.error('Service is down, failing fast');
  }
}
```

### Custom Storage Backend

Implement your own storage for distributed rate limiting:

```typescript
import { StorageBackend } from 'rate-limit-retry';

class RedisStorage implements StorageBackend {
  constructor(private client: RedisClient) {}

  async get(key: string): Promise<number | null> {
    const value = await this.client.get(key);
    return value ? parseInt(value, 10) : null;
  }

  async increment(key: string, ttl?: number): Promise<number> {
    const value = await this.client.incr(key);
    if (ttl && value === 1) {
      await this.client.expire(key, ttl / 1000);
    }
    return value;
  }

  async reset(key: string): Promise<void> {
    await this.client.set(key, '0');
  }

  async delete(key: string): Promise<void> {
    await this.client.del(key);
  }
}

// Use with rate limiter
const limiter = createRateLimiter({
  maxRequests: 100,
  windowMs: 60000,
  storage: new RedisStorage(redisClient),
});
```

## API Reference

### RateLimiter

| Method | Description |
|--------|-------------|
| `check(context?)` | Check if request is allowed |
| `reset(context?)` | Reset rate limit for a key |

### RetryHandler

| Method | Description |
|--------|-------------|
| `execute(fn)` | Execute function with retry logic |

### CircuitBreaker

| Method | Description |
|--------|-------------|
| `execute(fn)` | Execute function with circuit breaker protection |
| `getState()` | Get current circuit state |
| `getFailureCount()` | Get current failure count |
| `reset()` | Reset the circuit breaker |

### Retry Strategies

- `'fixed'` - Constant delay between retries
- `'exponential'` - Delay grows exponentially
- `'exponential-with-jitter'` - Exponential with random jitter (recommended)
- `'linear'` - Delay grows linearly
- `'custom'` - Use your own delay function

## License

MIT

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

---

Made with ❤️ by AVANT-ICONIC
