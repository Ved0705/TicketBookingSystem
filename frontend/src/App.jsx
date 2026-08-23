import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AuthProvider } from './lib.jsx';
import { Masthead, Protected } from './components.jsx';
import { EventDetail, EventList, Home } from './pages/Public.jsx';
import { Login, Register } from './pages/Auth.jsx';
import ShowSeats from './pages/ShowSeats.jsx';
import { Bookings, BookingDetail, Checkout, CustomerDashboard } from './pages/Booking.jsx';
import Waitlist from './pages/Waitlist.jsx';
import { OrganiserDashboard, OrganiserEvent } from './pages/Organiser.jsx';
import { AdminDashboard, AdminVenue } from './pages/Admin.jsx';

const customer = (el) => <Protected roles={['CUSTOMER']}>{el}</Protected>;

export default function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <div className="shell">
          <Masthead />
          <Routes>
            {/* Public */}
            <Route path="/" element={<Home />} />
            <Route path="/events" element={<EventList />} />
            <Route path="/events/:id" element={<EventDetail />} />
            <Route path="/shows/:showId" element={<ShowSeats />} />

            {/* Authentication */}
            <Route path="/login" element={<Login />} />
            <Route path="/register" element={<Register />} />

            {/* Customer */}
            <Route path="/dashboard" element={customer(<CustomerDashboard />)} />
            <Route path="/checkout/:holdId" element={customer(<Checkout />)} />
            <Route path="/bookings" element={customer(<Bookings />)} />
            <Route path="/bookings/:id" element={customer(<BookingDetail />)} />
            <Route path="/waitlist" element={customer(<Waitlist />)} />

            {/* Organiser */}
            <Route path="/organiser" element={<Protected roles={['ORGANISER']}><OrganiserDashboard /></Protected>} />
            <Route path="/organiser/events/:id" element={<Protected roles={['ORGANISER']}><OrganiserEvent /></Protected>} />

            {/* Admin */}
            <Route path="/admin" element={<Protected roles={['ADMIN']}><AdminDashboard /></Protected>} />
            <Route path="/admin/venues/:id" element={<Protected roles={['ADMIN']}><AdminVenue /></Protected>} />

            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
          <footer className="footer">
            Ticket Booking System — seats held server-side, released automatically when a hold expires.
          </footer>
        </div>
      </BrowserRouter>
    </AuthProvider>
  );
}
