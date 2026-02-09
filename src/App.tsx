// src/App.tsx
import { Routes, Route } from 'react-router-dom';
import MainApp from './MainApp'; 
import LocationSettings from './pages/LocationSettings';

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<MainApp />} />
      <Route path="/locationSettings" element={<LocationSettings />} />
    </Routes>
  );
}
