import { useState, useEffect } from 'react';
import { ref, onValue } from 'firebase/database';
import { db } from '../firebase'; // เปลี่ยน path ตามโปรเจกต์ของคุณ (standalone ไม่ใช้ shared)
import type { Location } from '../types';

interface Props {
  onSelect: (locationId: string | null) => void;
}

export default function LocationDropdown({ onSelect }: Props) {
  const [locations, setLocations] = useState<Location[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string>('');

  useEffect(() => {
    const locationsRef = ref(db, 'locations');

    const unsubscribe = onValue(locationsRef, (snapshot) => {
      const data = snapshot.val();
      if (data) {
        const list: Location[] = Object.entries(data).map(([id, loc]: [string, any]) => ({
          id,
          ...loc,
        }));
        setLocations(list);
      } else {
        setLocations([]);
      }
      setLoading(false);
    }, (err) => {
      setError(err.message);
      setLoading(false);
    });

    return () => unsubscribe();
  }, []);

  const handleChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const value = e.target.value;
    setSelected(value);
    onSelect(value || null);
  };

  return (
    <div className="mb-10">
      <label htmlFor="location" className="block text-xl font-medium text-gray-800 mb-3">
        เลือกสถานที่
      </label>
      {loading ? (
        <p className="text-gray-600">กำลังโหลดสถานที่...</p>
      ) : error ? (
        <p className="text-red-600">เกิดข้อผิดพลาด: {error}</p>
      ) : (
        <select
          id="location"
          value={selected}
          onChange={handleChange}
          className="w-full max-w-md px-4 py-3 border border-gray-300 rounded-lg shadow-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 text-lg transition"
        >
          <option value="">-- กรุณาเลือกสถานที่ --</option>
          {locations.map((loc) => (
            <option key={loc.id} value={loc.id}>
              {loc.name} - {loc.address.province}
            </option>
          ))}
        </select>
      )}
    </div>
  );
}