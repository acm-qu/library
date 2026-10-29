import { useRef } from 'react';
import { createBrowserRouter, Navigate, useNavigate, useParams, useRouteError, useSearchParams } from 'react-router';
import { ApiError } from '../api/client.ts';
import { useAsset, useEvent } from '../data/library.ts';
import { useMe } from '../data/session.ts';
import { safeNext } from '../lib/safeNext.ts';
import { EventScreen } from '../screens/Event.tsx';
import { Lightbox } from '../screens/Lightbox.tsx';
import { LoginScreen } from '../screens/Login.tsx';
import { NotFound, ServerError } from '../screens/States.tsx';
import { AppShell } from './AppShell.tsx';
import { screenRoutes } from './screens.tsx';
import { VideoPlayer } from '../ui/Player.tsx';

/** Someone already signed in skips the form; signing in on this page keeps it mounted for the welcome state. */
function LoginRoute() {
  const me = useMe();
  const [params] = useSearchParams();
  const arrivedSignedIn = useRef<boolean | null>(null);
  if (me.isPending) return null;
  arrivedSignedIn.current ??= !!me.data;
  return arrivedSignedIn.current ? <Navigate to={safeNext(params.get('next'))} replace /> : <LoginScreen />;
}

/** A direct visit to /p/:assetId: load the item, then its current event underneath. */
function DirectViewer() {
  const { assetId = '' } = useParams();
  const navigate = useNavigate();
  const asset = useAsset(assetId);
  const event = useEvent(asset.data?.eventId ?? '');
  if (asset.isError) return asset.error instanceof ApiError && asset.error.code === 'not_found' ? <NotFound /> : <ServerError onRetry={() => void asset.refetch()} />;
  return (
    <>
      {event.data && <EventScreen slug={event.data.slug} />}
      <Lightbox assetId={assetId} onClose={() => navigate(event.data ? `/events/${event.data.slug}` : '/')} player={(a) => <VideoPlayer asset={a} />} />
    </>
  );
}

function RouteError() {
  const err = useRouteError();
  return <ServerError reference={err instanceof ApiError ? err.body.reference : undefined} onRetry={() => location.reload()} />;
}

export const router = createBrowserRouter([
  { path: '/login', element: <LoginRoute />, errorElement: <RouteError /> },
  {
    element: <AppShell />,
    errorElement: <RouteError />,
    children: [...screenRoutes, { path: 'p/:assetId', element: <DirectViewer /> }, { path: '*', element: <NotFound /> }],
  },
]);
