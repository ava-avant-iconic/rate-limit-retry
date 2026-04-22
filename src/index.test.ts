/**
 * Tests for rate-limit-retry library
 */

import {
  MemoryStorage,
  RateLimiter,
  RetryHandler,
  CircuitBreaker,
  CircuitState,
  createRateLimiter,
  createRetryHandler,
  createCircuitBreaker,
  createManager,
} from './index';

describe('MemoryStorage', () => {
  let storage: MemoryStorage;

  beforeEach(() => {
    storage = new MemoryStorage();
  });

  test('should store and retrieve values', async () => {
    await storage.increment('test-key');
    const value = await storage.get('test-key');
    expect(value).toBe(1);
  });

  test('should increment values', async () => {
    await storage.increment('test-key');
    await storage.increment('test-key');
    const value = await storage.get('test-key');
    expect(value).toBe(2);
  });

  test('should reset values', async () => {
    await storage.increment('test-key');
    await storage.increment('test-key');
    await storage.reset('test-key');
    const value = await storage.get('test-key');
    expect(value).toBe(0);
  });

  test('should delete values', async () => {
    await storage.increment('test-key');
    await storage.delete('test-key');
    const value = await storage.get('test-key');
    expect(value).toBeNull();
  });

  test('should handle TTL expiry', async () => {
    await storage.increment('test-key', 100);
    await new Promise((resolve) => setTimeout(resolve, 150));
    const value = await storage.get('test-key');
    expect(value).toBeNull();
  });
});

describe('RateLimiter', () => {
  let limiter: RateLimiter;

  beforeEach(() => {
    limiter = new RateLimiter({
      maxRequests: 5,
      windowMs: 1000,
    });
  });

  test('should allow requests within limit', async () => {
    const result = await limiter.check();
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(4);
  });

  test('should block requests exceeding limit', async () => {
    for (let i = 0; i < 5; i++) {
      await limiter.check();
    }

    const result = await limiter.check();
    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);
  });

  test('should provide correct rate limit info', async () => {
    const result = await limiter.check();
    expect(result.current).toBe(1);
    expect(result.limit).toBe(5);
    expect(result.resetTimeMs).toBeGreaterThan(0);
  });
});

describe('RetryHandler', () => {
  test('should succeed on first attempt', async () => {
    const handler = createRetryHandler({
      maxAttempts: 3,
      initialDelayMs: 10,
      maxDelayMs: 100,
      strategy: 'exponential',
    });

    const mockFn = jest.fn().mockResolvedValue('success');
    const result = await handler.execute(mockFn);

    expect(result.success).toBe(true);
    expect(result.result).toBe('success');
    expect(result.attempts).toBe(1);
    expect(mockFn).toHaveBeenCalledTimes(1);
  });

  test('should retry on failure', async () => {
    const handler = createRetryHandler({
      maxAttempts: 3,
      initialDelayMs: 10,
      maxDelayMs: 100,
      strategy: 'fixed',
    });

    const mockFn = jest
      .fn()
      .mockRejectedValueOnce(new Error('fail'))
      .mockResolvedValue('success');

    const result = await handler.execute(mockFn);

    expect(result.success).toBe(true);
    expect(result.result).toBe('success');
    expect(result.attempts).toBe(2);
    expect(mockFn).toHaveBeenCalledTimes(2);
  });

  test('should give up after max attempts', async () => {
    const handler = createRetryHandler({
      maxAttempts: 2,
      initialDelayMs: 10,
      maxDelayMs: 100,
      strategy: 'fixed',
    });

    const mockFn = jest.fn().mockRejectedValue(new Error('fail'));
    const result = await handler.execute(mockFn);

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.attempts).toBe(3); // 2 retries + 1 initial
    expect(mockFn).toHaveBeenCalledTimes(3);
  });

  test('should respect isRetryable callback', async () => {
    const customIsRetryable = (error: Error) => {
      const retryable = error.message === 'retryable error';
      return retryable;
    };

    const handler = createRetryHandler({
      maxAttempts: 3,
      initialDelayMs: 10,
      maxDelayMs: 100,
      strategy: 'fixed',
      isRetryable: customIsRetryable,
    });

    const mockFn = jest.fn().mockImplementation(() => {
      throw new Error('non-retryable error');
    });

    const result = await handler.execute(mockFn);

    expect(result.success).toBe(false);
    // Should be called only once since error is not retryable
    expect(mockFn).toHaveBeenCalledTimes(1);
  });

  test('should use exponential backoff', async () => {
    const handler = createRetryHandler({
      maxAttempts: 3,
      initialDelayMs: 10,
      maxDelayMs: 1000,
      strategy: 'exponential',
      backoffMultiplier: 2,
    });

    const mockFn = jest
      .fn()
      .mockRejectedValueOnce(new Error('fail1'))
      .mockRejectedValueOnce(new Error('fail2'))
      .mockResolvedValue('success');

    await handler.execute(mockFn);
    // At least 2 retries should have been attempted with increasing delays
    expect(mockFn).toHaveBeenCalledTimes(3);
  });
});

describe('CircuitBreaker', () => {
  test('should be closed initially', () => {
    const breaker = createCircuitBreaker();
    expect(breaker.getState()).toBe(CircuitState.CLOSED);
  });

  test('should open after failure threshold', async () => {
    const breaker = createCircuitBreaker({
      failureThreshold: 2,
      resetTimeoutMs: 100,
      successThreshold: 1,
    });

    const mockFn = jest.fn().mockRejectedValue(new Error('fail'));

    try {
      await breaker.execute(mockFn);
    } catch (e) {
      // Ignore
    }

    try {
      await breaker.execute(mockFn);
    } catch (e) {
      // Ignore
    }

    expect(breaker.getState()).toBe(CircuitState.OPEN);
  });

  test('should transition to half-open after timeout', async () => {
    const breaker = createCircuitBreaker({
      failureThreshold: 1,
      resetTimeoutMs: 50,
      successThreshold: 1,
    });

    const mockFail = jest.fn().mockRejectedValue(new Error('fail'));

    try {
      await breaker.execute(mockFail);
    } catch (e) {
      // Ignore
    }

    expect(breaker.getState()).toBe(CircuitState.OPEN);

    await new Promise((resolve) => setTimeout(resolve, 60));

    const mockSuccess = jest.fn().mockResolvedValue('success');
    await breaker.execute(mockSuccess);

    expect(breaker.getState()).toBe(CircuitState.CLOSED);
  });

  test('should fail fast when open', async () => {
    const breaker = createCircuitBreaker({
      failureThreshold: 1,
      resetTimeoutMs: 1000,
      successThreshold: 1,
    });

    const mockFn = jest.fn().mockRejectedValue(new Error('fail'));

    try {
      await breaker.execute(mockFn);
    } catch (e) {
      // Ignore
    }

    expect(breaker.getState()).toBe(CircuitState.OPEN);

    const result = await breaker.execute(mockFn).catch((e) => e);
    expect((result as Error).message).toContain('OPEN');
  });

  test('should reset on success in half-open', async () => {
    const breaker = createCircuitBreaker({
      failureThreshold: 1,
      resetTimeoutMs: 50,
      successThreshold: 2,
    });

    const mockFail = jest.fn().mockRejectedValue(new Error('fail'));

    try {
      await breaker.execute(mockFail);
    } catch (e) {
      // Ignore
    }

    expect(breaker.getState()).toBe(CircuitState.OPEN);

    await new Promise((resolve) => setTimeout(resolve, 60));

    const mockSuccess = jest.fn().mockResolvedValue('success');
    await breaker.execute(mockSuccess);
    expect(breaker.getState()).toBe(CircuitState.HALF_OPEN);

    await breaker.execute(mockSuccess);
    expect(breaker.getState()).toBe(CircuitState.CLOSED);
  });

  test('should be resettable', () => {
    const breaker = createCircuitBreaker();
    breaker.reset();
    expect(breaker.getState()).toBe(CircuitState.CLOSED);
    expect(breaker.getFailureCount()).toBe(0);
  });
});

describe('createManager', () => {
  test('should create a working manager', async () => {
    const manager = createManager(
      { maxRequests: 10, windowMs: 60000 },
      { maxAttempts: 2, initialDelayMs: 10, maxDelayMs: 100, strategy: 'fixed' },
      { failureThreshold: 3, resetTimeoutMs: 100, successThreshold: 1 },
    );

    const mockFn = jest.fn().mockResolvedValue('success');
    const result = await manager.execute(mockFn);

    expect(result.success).toBe(true);
    expect(result.result).toBe('success');
  });

  test('should respect rate limits', async () => {
    const manager = createManager(
      { maxRequests: 2, windowMs: 60000 },
      { maxAttempts: 2, initialDelayMs: 10, maxDelayMs: 100, strategy: 'fixed' },
      { failureThreshold: 3, resetTimeoutMs: 100, successThreshold: 1 },
    );

    const mockFn = jest.fn().mockResolvedValue('success');

    await manager.execute(mockFn);
    await manager.execute(mockFn);

    const result = await manager.execute(mockFn);
    expect(result.success).toBe(false);
    expect(result.error?.message).toContain('Rate limit exceeded');
  });

  test('should provide access to components', async () => {
    const manager = createManager();

    const components = manager.getComponents();
    expect(components).toHaveProperty('rateLimiter');
    expect(components).toHaveProperty('retryHandler');
    expect(components).toHaveProperty('circuitBreaker');

    expect(components.rateLimiter).toBeInstanceOf(RateLimiter);
    expect(components.retryHandler).toBeInstanceOf(RetryHandler);
    expect(components.circuitBreaker).toBeInstanceOf(CircuitBreaker);
  });
});

describe('Factory functions', () => {
  test('createRateLimiter should create with defaults', () => {
    const limiter = createRateLimiter();
    expect(limiter).toBeInstanceOf(RateLimiter);
  });

  test('createRetryHandler should create with defaults', () => {
    const handler = createRetryHandler();
    expect(handler).toBeInstanceOf(RetryHandler);
  });

  test('createCircuitBreaker should create with defaults', () => {
    const breaker = createCircuitBreaker();
    expect(breaker).toBeInstanceOf(CircuitBreaker);
  });

  test('createManager should create with defaults', () => {
    const manager = createManager();
    const components = manager.getComponents();

    expect(components.rateLimiter).toBeInstanceOf(RateLimiter);
    expect(components.retryHandler).toBeInstanceOf(RetryHandler);
    expect(components.circuitBreaker).toBeInstanceOf(CircuitBreaker);
  });
});
