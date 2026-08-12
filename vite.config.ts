import { defineConfig } from 'vitest/config'

export default defineConfig({
  // Пути к ассетам относительные: тогда сайт одинаково работает и в корне
  // домена, и из подпути /<repo>/ на GitHub Pages — правки под имя
  // репозитория не требуются.
  base: './',
  build: {
    target: 'es2022',
  },
  worker: {
    format: 'es',
  },
  test: {
    globals: true,
    // Логика намеренно не трогает DOM: всё, что нужно тестам (WebCrypto,
    // CompressionStream, TextEncoder), есть в Node 18+ как глобалы.
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
})
