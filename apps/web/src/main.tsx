import '@fontsource-variable/fraunces';
import '@fontsource-variable/hanken-grotesk';
import './styles/tokens.css';
import './styles/base.css';
import './lib/zod-csp.ts';
import './i18n/index.ts';
import './lib/theme.ts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider } from 'react-router';
import { ApiError } from './api/client.ts';
import { router } from './routes/router.tsx';

document.documentElement.classList.add('app');

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Retry only transient failures; a 404 or 401 is an answer.
      retry: (n, e) => n < 2 && (!(e instanceof ApiError) || e.code === 'network' || e.status >= 500),
      refetchOnWindowFocus: false,
    },
  },
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
