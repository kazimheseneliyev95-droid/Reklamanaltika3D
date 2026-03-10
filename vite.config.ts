import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],

  optimizeDeps: {
    exclude: ['lucide-react'],
  },

  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined;

          if (id.includes('react-router-dom') || id.includes('react-router')) return 'router';
          if (id.includes('@faker-js/faker')) return 'faker';
          if (id.includes('react-dom') || id.includes('react/') || id.includes('scheduler')) return 'react-vendor';
          if (id.includes('socket.io-client')) return 'socket';
          if (id.includes('lucide-react')) return 'icons';
          if (id.includes('date-fns')) return 'date-utils';

          if (
            id.includes('@radix-ui') ||
            id.includes('clsx') ||
            id.includes('tailwind-merge') ||
            id.includes('react-qr-code')
          ) {
            return 'ui-vendor';
          }

          return 'vendor';
        },
      },
    },
  },
});
