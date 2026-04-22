/**
 * Rate Limit Retry Library
 *
 * A robust TypeScript library for combining rate limiting with exponential backoff,
 * retry strategies, and circuit breaker patterns for production services.
 */

// ============================================================================
// Type Definitions
// ============================================================================

/**
 * Strategy for determining wait time between retries
 */
export type RetryStrategy =
  | 'fixed'
  | 'exponential'
  | 'exponential-with-jitter'
  | 'linear'
  | 'custom';

/**
 * Storage backend for tracking rate limit state
 */
export interface StorageBackend {
  /**
   * Get the current count for a key
   */
  get(key: string): Promise<number | null>;

  /**
   * Increment the count for a key with optional expiry
   */
  increment(key: string, ttl?: number): Promise<number>;

  /**
   * Reset the count for a key
   */
  reset(key: string): Promise<void>;

  /**
   * Delete a key
   */
  delete(key: string): Promise<void>;
}

/**
 * Circuit breaker states
 */
export enum CircuitState {
  CLOSED = 'closed',      // Normal operation
  OPEN = 'open',          // Circuit is open, requests fail fast
  HALF_OPEN = 'half-open' // Testing if service recovered
}

/**
 * Configuration for rate limiting
 */
export interface RateLimitConfig {
  /**
   * Maximum number of requests allowed
   */
  maxRequests: number;

  /**
   * Time window in milliseconds
   */
  windowMs: number;

  /**
   * Storage backend for tracking state
   */
  storage?: StorageBackend;

  /**
   * Custom key function to group requests
   */
  keyGenerator?: (context: any) => string;
}

/**
 * Configuration for retry logic
 */
export interface RetryConfig {
  /**
   * Maximum number of retry attempts
   */
  maxAttempts: number;

  /**
   * Initial delay in milliseconds
   */
  initialDelayMs: number;

  /**
   * Maximum delay in milliseconds
   */
  maxDelayMs: number;

  /**
   * Strategy for calculating retry delays
   */
  strategy: RetryStrategy;

  /**
   * Multiplier for exponential backoff
   */
  backoffMultiplier?: number;

  /**
   * Custom delay function for 'custom' strategy
   */
  customDelayFn?: (attempt: number, error: Error) => number;

  /**
   * Function to determine if an error is retryable
   */
  isRetryable?: (error: Error) => boolean;

  /**
   * Callback before each retry attempt
   */
  onRetry?: (attempt: number, error: Error, delayMs: number) => void;
}

/**
 * Configuration for circuit breaker
 */
export interface CircuitBreakerConfig {
  /**
   * Number of consecutive failures before opening
   */
  failureThreshold: number;

  /**
   * Time in milliseconds to keep circuit open before attempting recovery
   */
  resetTimeoutMs: number;

  /**
   * Number of successful requests needed to close circuit in half-open state
   */
  successThreshold: number;

  /**
   * Callback when circuit state changes
   */
  onStateChange?: (from: CircuitState, to: CircuitState) => void;
}

/**
 * Result of a rate limit check
 */
export interface RateLimitResult {
  /**
   * Whether the request is allowed
   */
  allowed: boolean;

  /**
   * Current count in the window
   */
  current: number;

  /**
   * Maximum requests allowed
   */
  limit: number;

  /**
   * Remaining requests
   */
  remaining: number;

  /**
   * Time until window resets in milliseconds
   */
  resetTimeMs: number;
}

/**
 * Result of a retry attempt
 */
export interface RetryResult<T> {
  /**
   * Whether the operation succeeded
   */
  success: boolean;

  /**
   * The result if successful
   */
  result?: T;

  /**
   * The last error if failed
   */
  error?: Error;

  /**
   * Number of attempts made
   */
  attempts: number;

  /**
   * Total time spent in milliseconds
   */
  totalTimeMs: number;
}

// ============================================================================
// In-Memory Storage Backend
// ============================================================================

/**
 * Simple in-memory storage backend for development/testing
 */
export class MemoryStorage implements StorageBackend {
  private store = new Map<string, { value: number; expiry: number }>();

  private cleanup(): void {
    const now = Date.now();
    for (const [key, data] of this.store.entries()) {
      if (data.expiry > 0 && data.expiry <= now) {
        this.store.delete(key);
      }
    }
  }

  async get(key: string): Promise<number | null> {
    this.cleanup();
    const data = this.store.get(key);
    if (!data) return null;
    if (data.expiry > 0 && data.expiry <= Date.now()) {
      this.store.delete(key);
      return null;
    }
    return data.value;
  }

  async increment(key: string, ttl?: number): Promise<number> {
    this.cleanup();
    const data = this.store.get(key);
    const now = Date.now();

    if (!data || (data.expiry > 0 && data.expiry <= now)) {
      const expiry = ttl ? now + ttl : 0;
      this.store.set(key, { value: 1, expiry });
      return 1;
    }

    data.value++;
    return data.value;
  }

  async reset(key: string): Promise<void> {
    this.store.set(key, { value: 0, expiry: 0 });
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }
}

// ============================================================================
// Rate Limiter
// ============================================================================

/**
 * Rate limiter implementation using sliding window algorithm
 */
export class RateLimiter {
  constructor(private config: RateLimitConfig) {
    this.config.storage = config.storage || new MemoryStorage();
  }

  /**
   * Check if a request is allowed based on rate limit
   */
  async check(context?: any): Promise<RateLimitResult> {
    const key = this.getKey(context);
    const storage = this.config.storage!;

    const current = await storage.get(key);

    if (current === null || current < this.config.maxRequests) {
      const newCount = await storage.increment(key, this.config.windowMs);
      const remaining = Math.max(0, this.config.maxRequests - newCount);

      return {
        allowed: remaining > 0,
        current: newCount,
        limit: this.config.maxRequests,
        remaining,
        resetTimeMs: this.config.windowMs,
      };
    }

    // Rate limit exceeded
    return {
      allowed: false,
      current: current,
      limit: this.config.maxRequests,
      remaining: 0,
      resetTimeMs: this.config.windowMs,
    };
  }

  /**
   * Reset rate limit for a specific key
   */
  async reset(context?: any): Promise<void> {
    const key = this.getKey(context);
    await this.config.storage!.reset(key);
  }

  private getKey(context?: any): string {
    if (this.config.keyGenerator) {
      return this.config.keyGenerator(context);
    }
    return 'default';
  }
}

// ============================================================================
// Retry Handler
// ============================================================================

/**
 * Retry handler with configurable backoff strategies
 */
export class RetryHandler {
  constructor(private config: RetryConfig) {}

  /**
   * Execute a function with retry logic
   */
  async execute<T>(fn: () => Promise<T>): Promise<RetryResult<T>> {
    const startTime = Date.now();
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= this.config.maxAttempts; attempt++) {
      try {
        const result = await fn();
        return {
          success: true,
          result,
          attempts: attempt + 1,
          totalTimeMs: Date.now() - startTime,
        };
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        // Check if error is retryable
        if (
          this.config.isRetryable &&
          !this.config.isRetryable(lastError)
        ) {
          break;
        }

        // Don't retry on last attempt
        if (attempt === this.config.maxAttempts) {
          break;
        }

        // Calculate delay and wait
        const delayMs = this.calculateDelay(attempt);
        this.config.onRetry?.(attempt + 1, lastError, delayMs);

        await this.sleep(delayMs);
      }
    }

    return {
      success: false,
      error: lastError,
      attempts: this.config.maxAttempts + 1,
      totalTimeMs: Date.now() - startTime,
    };
  }

  private calculateDelay(attempt: number): number {
    const { initialDelayMs, maxDelayMs, strategy, backoffMultiplier = 2 } = this.config;

    switch (strategy) {
      case 'fixed':
        return Math.min(initialDelayMs, maxDelayMs);

      case 'exponential':
        return Math.min(initialDelayMs * Math.pow(backoffMultiplier, attempt), maxDelayMs);

      case 'exponential-with-jitter': {
        const exponentialDelay = initialDelayMs * Math.pow(backoffMultiplier, attempt);
        const jitter = exponentialDelay * 0.1 * (Math.random() * 2 - 1);
        return Math.min(exponentialDelay + jitter, maxDelayMs);
      }

      case 'linear':
        return Math.min(initialDelayMs * (attempt + 1), maxDelayMs);

      case 'custom':
        if (this.config.customDelayFn) {
          return this.config.customDelayFn(attempt, new Error());
        }
        return initialDelayMs;

      default:
        return initialDelayMs;
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// ============================================================================
// Circuit Breaker
// ============================================================================

/**
 * Circuit breaker implementation to prevent cascading failures
 */
export class CircuitBreaker {
  private state: CircuitState = CircuitState.CLOSED;
  private failureCount = 0;
  private successCount = 0;
  private lastFailureTime = 0;

  constructor(private config: CircuitBreakerConfig) {}

  /**
   * Execute a function with circuit breaker protection
   */
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === CircuitState.OPEN) {
      // Check if we should transition to half-open
      if (Date.now() - this.lastFailureTime > this.config.resetTimeoutMs) {
        this.transition(CircuitState.HALF_OPEN);
      } else {
        throw new Error('Circuit breaker is OPEN - request rejected');
      }
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }

  /**
   * Get current circuit state
   */
  getState(): CircuitState {
    return this.state;
  }

  /**
   * Get current failure count
   */
  getFailureCount(): number {
    return this.failureCount;
  }

  /**
   * Reset the circuit breaker
   */
  reset(): void {
    this.failureCount = 0;
    this.successCount = 0;
    this.lastFailureTime = 0;
    this.transition(CircuitState.CLOSED);
  }

  private onSuccess(): void {
    if (this.state === CircuitState.HALF_OPEN) {
      this.successCount++;
      if (this.successCount >= this.config.successThreshold) {
        this.transition(CircuitState.CLOSED);
      }
    } else {
      this.failureCount = 0;
    }
  }

  private onFailure(): void {
    this.failureCount++;
    this.lastFailureTime = Date.now();
    this.successCount = 0;

    if (this.failureCount >= this.config.failureThreshold) {
      this.transition(CircuitState.OPEN);
    }
  }

  private transition(newState: CircuitState): void {
    const oldState = this.state;
    this.state = newState;
    this.config.onStateChange?.(oldState, newState);
  }
}

// ============================================================================
// Combined Rate Limit Retry Manager
// ============================================================================

/**
 * Combined manager integrating rate limiting, retry, and circuit breaker
 */
export class RateLimitRetryManager {
  private rateLimiter: RateLimiter;
  private retryHandler: RetryHandler;
  private circuitBreaker: CircuitBreaker;

  constructor(
    rateLimitConfig: RateLimitConfig,
    retryConfig: RetryConfig,
    circuitBreakerConfig: CircuitBreakerConfig,
  ) {
    this.rateLimiter = new RateLimiter(rateLimitConfig);
    this.retryHandler = new RetryHandler(retryConfig);
    this.circuitBreaker = new CircuitBreaker(circuitBreakerConfig);
  }

  /**
   * Execute a function with full protection (rate limit + retry + circuit breaker)
   */
  async execute<T>(fn: () => Promise<T>, context?: any): Promise<RetryResult<T>> {
    // Check rate limit first
    const rateLimitResult = await this.rateLimiter.check(context);
    if (!rateLimitResult.allowed) {
      return {
        success: false,
        error: new Error(`Rate limit exceeded: ${rateLimitResult.current}/${rateLimitResult.limit}`),
        attempts: 0,
        totalTimeMs: 0,
      };
    }

    // Execute with circuit breaker and retry
    const result = await this.retryHandler.execute(async () => {
      return await this.circuitBreaker.execute(fn);
    });

    return result;
  }

  /**
   * Get the underlying components for advanced usage
   */
  getComponents() {
    return {
      rateLimiter: this.rateLimiter,
      retryHandler: this.retryHandler,
      circuitBreaker: this.circuitBreaker,
    };
  }
}

// ============================================================================
// Factory Functions
// ============================================================================

/**
 * Create a rate limiter with default configuration
 */
export function createRateLimiter(config: Partial<RateLimitConfig> = {}): RateLimiter {
  const defaults: RateLimitConfig = {
    maxRequests: 100,
    windowMs: 60000, // 1 minute
  };
  return new RateLimiter({ ...defaults, ...config });
}

/**
 * Create a retry handler with default configuration
 */
export function createRetryHandler(config: Partial<RetryConfig> = {}): RetryHandler {
  const defaults: RetryConfig = {
    maxAttempts: 3,
    initialDelayMs: 1000,
    maxDelayMs: 30000,
    strategy: 'exponential-with-jitter',
  };
  return new RetryHandler({ ...defaults, ...config });
}

/**
 * Create a circuit breaker with default configuration
 */
export function createCircuitBreaker(config: Partial<CircuitBreakerConfig> = {}): CircuitBreaker {
  const defaults: CircuitBreakerConfig = {
    failureThreshold: 5,
    resetTimeoutMs: 60000, // 1 minute
    successThreshold: 2,
  };
  return new CircuitBreaker({ ...defaults, ...config });
}

/**
 * Create a complete rate limit retry manager with default configuration
 */
export function createManager(
  rateLimitConfig?: Partial<RateLimitConfig>,
  retryConfig?: Partial<RetryConfig>,
  circuitBreakerConfig?: Partial<CircuitBreakerConfig>,
): RateLimitRetryManager {
  const rlDefaults: RateLimitConfig = { maxRequests: 100, windowMs: 60000 };
  const rtDefaults: RetryConfig = { maxAttempts: 3, initialDelayMs: 1000, maxDelayMs: 30000, strategy: 'exponential-with-jitter' };
  const cbDefaults: CircuitBreakerConfig = { failureThreshold: 5, resetTimeoutMs: 60000, successThreshold: 2 };

  return new RateLimitRetryManager(
    { ...rlDefaults, ...rateLimitConfig },
    { ...rtDefaults, ...retryConfig },
    { ...cbDefaults, ...circuitBreakerConfig },
  );
}
