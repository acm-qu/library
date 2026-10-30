// App screens (the library is public; account, upload and admin need a session). Shared by the router and by the lightbox's background renderer, which shows the
// previous screen under /p/:assetId when the viewer was opened from a grid.
import { Navigate, type RouteObject, useLocation } from 'react-router';
import { useMe } from '../data/session.ts';
import { AccountScreen } from '../screens/Account.tsx';
import { EventScreen } from '../screens/Event.tsx';
import { LibraryScreen } from '../screens/Library.tsx';
import { MyUploadsScreen } from '../screens/MyUploads.tsx';
import { NotFound } from '../screens/States.tsx';
import { UploadScreen } from '../screens/Upload.tsx';
import { ItemScreen } from '../screens/admin/Item.tsx';
import { EventsScreen } from '../screens/admin/Events.tsx';
import { AdminLayout } from '../screens/admin/Layout.tsx';
import { MembersScreen } from '../screens/admin/Members.tsx';
import { QueueScreen } from '../screens/admin/Queue.tsx';
import { StorageScreen } from '../screens/admin/Storage.tsx';

/** Core-only screens look like any missing page to members. */
function CoreOnly({ children }: { children: React.ReactNode }) {
  return useMe().data?.role === 'core' ? <>{children}</> : <NotFound />;
}

/** Screens that only make sense with a session send signed-out visitors to sign in, then back. */
function SignedIn({ children }: { children: React.ReactNode }) {
  const loc = useLocation();
  return useMe().data ? <>{children}</> : <Navigate to={`/login?next=${encodeURIComponent(loc.pathname + loc.search)}`} replace />;
}

export const screenRoutes: RouteObject[] = [
  { index: true, element: <LibraryScreen /> },
  { path: 'events/:slug', element: <EventScreen /> },
  { path: 'account', element: <SignedIn><AccountScreen /></SignedIn> },
  { path: 'upload', element: <CoreOnly><UploadScreen /></CoreOnly> },
  { path: 'uploads', element: <CoreOnly><MyUploadsScreen /></CoreOnly> },
  {
    path: 'admin',
    element: <AdminLayout />,
    children: [
      { index: true, element: <Navigate to="/admin/queue" replace /> },
      { path: 'members', element: <MembersScreen /> },
      { path: 'events', element: <EventsScreen /> },
      { path: 'queue', element: <QueueScreen /> },
      { path: 'items/:assetId', element: <ItemScreen /> },
      { path: 'storage', element: <StorageScreen /> },
    ],
  },
];
