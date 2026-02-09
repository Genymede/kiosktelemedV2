import { useEffect, useState } from 'react';
import { ref, onValue, push, set } from 'firebase/database';
import { db } from '../firebase';
import Swal from 'sweetalert2';
import { MapPin, Plus } from 'lucide-react';

type Location = {
  id: string;
  name: string;
  active: boolean;
  address: {
    name?: string;
    houseNo?: string;
    moo?: string;
    soi?: string;
    road?: string;
    subDistrict?: string;
    district?: string;
    province?: string;
    postcode?: string;
  };
};

export default function LocationSettings() {
  const [locations, setLocations] = useState<Location[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [currentLocation, setCurrentLocation] = useState<{
    locationId: string;
    name: string;
  } | null>(null);

  useEffect(() => {
    const raw = localStorage.getItem('selectedLocation');
    if (!raw) return;

    try {
      const parsed = JSON.parse(raw);
      if (parsed?.locationId && parsed?.name) { 
        setCurrentLocation(parsed);
      }
    } catch (e) {
      console.error('Invalid selectedLocation', e);
    }
  }, []);


  useEffect(() => {
    const locationsRef = ref(db, 'locations');

    const unsubscribe = onValue(locationsRef, (snapshot) => {
      const data = snapshot.val() || {};

      const list: Location[] = Object.entries(data)
        .map(([id, value]: any) => ({
          id,
          name: value.name,
          active: value.active ?? false,
          address: value.address || {},
        }))
        .filter((loc) => loc.active);

      setLocations(list);
      setLoading(false);
    });

    return () => unsubscribe();
  }, []);

  const filteredLocations = locations.filter(
    (loc) =>
      loc.name.toLowerCase().includes(search.toLowerCase()) ||
      loc.address.province?.includes(search) ||
      loc.address.district?.includes(search)
  );

  const handleSelectLocation = (loc: Location) => {
    
    localStorage.setItem(
      'selectedLocation',
      JSON.stringify({
        locationId: loc.id,
        name: loc.name,
      })
    );

    Swal.fire({
      icon: 'success',
      title: 'เลือกสถานที่เรียบร้อย',
      text: loc.name,
      timer: 1500,
      showConfirmButton: false,
    });

    setTimeout(() => {
      window.location.reload();
    }, 1600);
  };

  // ➕ เพิ่มสถานที่
  const handleAddLocation = async () => {
    const { value: form } = await Swal.fire({
      title: 'เพิ่มสถานที่ใหม่',
      html: `
        <input id="name" class="swal2-input" placeholder="ชื่อสถานที่">
        <input id="addrName" class="swal2-input" placeholder="ชื่ออาคาร / สถานที่">
        <input id="houseNo" class="swal2-input" placeholder="บ้านเลขที่">
        <input id="road" class="swal2-input" placeholder="ถนน">
        <input id="subDistrict" class="swal2-input" placeholder="แขวง / ตำบล">
        <input id="district" class="swal2-input" placeholder="เขต / อำเภอ">
        <input id="province" class="swal2-input" placeholder="จังหวัด">
        <input id="postcode" class="swal2-input" placeholder="รหัสไปรษณีย์">
      `,
      focusConfirm: false,
      showCancelButton: true,
      confirmButtonText: 'บันทึก',
      cancelButtonText: 'ยกเลิก',
      preConfirm: () => {
        const get = (id: string) =>
          (document.getElementById(id) as HTMLInputElement)?.value;

        if (!get('name')) {
          Swal.showValidationMessage('กรุณากรอกชื่อสถานที่');
          return;
        }

        return {
          name: get('name'),
          address: {
            name: get('addrName'),
            houseNo: get('houseNo'),
            road: get('road'),
            subDistrict: get('subDistrict'),
            district: get('district'),
            province: get('province'),
            postcode: get('postcode'),
          },
        };
      },
    });

    if (!form) return;

    try {
      const newRef = push(ref(db, 'locations'));

      await set(newRef, {
        name: form.name,
        active: true,
        address: {
          ...form.address,
          moo: '',
          soi: '',
        },
      });

      Swal.fire({
        icon: 'success',
        title: 'เพิ่มสถานที่สำเร็จ',
        timer: 1500,
        showConfirmButton: false,
      });
    } catch (err) {
      console.error(err);
      Swal.fire('ผิดพลาด', 'ไม่สามารถเพิ่มสถานที่ได้', 'error');
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-indigo-50 to-blue-100 px-6 py-12">
      <div className="max-w-5xl mx-auto">
        {/* Header */}
        <div className="flex justify-between items-center mb-8">
          <h1 className="text-4xl font-extrabold text-indigo-900">
            ตั้งค่าสถานที่
          </h1>

          <button
            onClick={handleAddLocation}
            className="flex items-center gap-2 px-5 py-3 bg-green-600 hover:bg-green-700 text-white rounded-xl font-bold"
          >
            <Plus size={18} />
            เพิ่มสถานที่
          </button>
        </div>
        <div className="mb-6 text-gray-700">
          สถานที่ปัจจุบัน {currentLocation ? (
            <span className="font-semibold">{currentLocation.name}</span>
          ) : (
            <span className="font-semibold text-red-600">ยังไม่ได้เลือก</span>
          )}
        </div>
        {/* Search */}
        <div className="max-w-md mx-auto mb-10">
          <input
            type="text"
            placeholder="ค้นหาชื่อสถานที่ / จังหวัด / เขต"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full px-4 py-3 rounded-xl border border-gray-300 focus:ring-2 focus:ring-indigo-400 outline-none"
          />
        </div>

        {/* Content */}
        {loading ? (
          <div className="text-center text-xl text-gray-600 animate-pulse">
            กำลังโหลดข้อมูลสถานที่...
          </div>
        ) : filteredLocations.length === 0 ? (
          <div className="text-center text-lg text-gray-500">
            ไม่พบสถานที่
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
            {filteredLocations.map((loc) => (
              <div
                key={loc.id}
                className="bg-white rounded-2xl shadow-lg p-6 hover:shadow-xl transition"
              >
                <h2 className="text-2xl font-bold text-gray-900 mb-2">
                  {loc.name}
                </h2>

                <div className="text-sm text-gray-600 flex items-center gap-2 mb-1">
                  <MapPin size={16} />
                  {loc.address.name}
                </div>

                <div className="text-sm text-gray-500">
                  {loc.address.houseNo} {loc.address.road}{' '}
                  {loc.address.subDistrict} {loc.address.district}
                </div>

                <div className="text-sm text-gray-500 mb-4">
                  {loc.address.province} {loc.address.postcode}
                </div>

                {currentLocation?.locationId === loc.id ? (
                  <div className="mb-4 text-green-600 font-semibold">
                    สถานที่ที่เลือกอยู่ในขณะนี้
                  </div>
                ) : (
                  <button
                    onClick={() => handleSelectLocation(loc)}
                    className="w-full py-3 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white font-bold"
                  >
                    เลือกสถานที่นี้
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
