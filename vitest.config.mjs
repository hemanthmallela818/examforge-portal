import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// Component behaviour tests (jsdom). Node's built-in runner keeps running tests/*.test.mjs.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    include: ['tests/components/**/*.test.jsx'],
    setupFiles: ['tests/components/setup.js'],
    restoreMocks: true
  }
});
