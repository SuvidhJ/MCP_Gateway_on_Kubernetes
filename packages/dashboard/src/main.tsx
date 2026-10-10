import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App } from './App';
import { ApiError } from './api';
import './styles.css';

const queryClient: QueryClient = new QueryClient({
  // A 401 from any query means the session ended: drop to the login screen.
  queryCache: new QueryCache({
    onError: (e) => { if (e instanceof ApiError && e.status === 401) queryClient.setQueryData(['me'], null); },
  }),
  defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false, staleTime: 1000 } },
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);
