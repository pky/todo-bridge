import type { E2EConfig } from 'e2e'
import { web } from '@e2e-dev/web'

export default {
  tests: 'verification/tests/**/*.e2e.ts',
  targets: [{
    name: 'mobile-web',
    engine: web({ viewport: { width: 390, height: 844 }, locale: 'ja-JP', timezoneId: 'Asia/Tokyo' }),
    app: {
      url: 'http://127.0.0.1:0',
      environment: 'test',
      command: {
        executable: 'node',
        args: ['verification/start.mjs', '{port}'],
        inheritEnv: ['JAVA_HOME'],
        startupTimeout: 120_000,
        shutdownTimeout: 15_000,
        log: '.e2e/logs/app.log',
      },
    },
  }],
  workers: 1,
  retries: 0,
  trace: 'on',
} satisfies E2EConfig
