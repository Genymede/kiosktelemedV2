import { useState, useEffect } from 'react';
import { ref, onValue, set, update } from 'firebase/database';
import { db } from './firebase';
import type { Doctor } from './types';
// import LocationDropdown from './components/LocationDropdown';
import CallRoom from './pages/CallRoom';
import Swal from 'sweetalert2';
import './index.css'

export default function MainApp() {
  const [selectedLocationId, setSelectedLocationId] = useState<string | null>(null);
  const [doctors, setDoctors] = useState<Doctor[]>([]);
  const [loadingDoctors, setLoadingDoctors] = useState(false);
  const [errorDoctors, setErrorDoctors] = useState<string | null>(null);
  const [activeRoom, setActiveRoom] = useState<{
    doctorName: string;
    roomId: string;
    doctorId: string;
    requestId: string;
    origin: string;
  } | null>(null);
  const [selectedLocation, setSelectedLocation] = useState<{
    locationId: string;
    name: string;
  } | null>(null);
  const [patName, setPatName] = useState<string>('');

  const createConsultRequest = async (
    doctorId: string,
    requestId: string,
    roomId: string,
    patientName: string,
    origin: string
  ) => {
    await set(ref(db, `consultRequests/${doctorId}/${requestId}`), {
      patientName,
      timestamp: Date.now(),
      roomId,
      status: 'pending',
      roomState: 'waiting',
      origin,
    });
  };

  const notificationServerUrl = "https://notification-server-ruddy.vercel.app"

  const waitForDoctorResponse = (doctorId: string, requestId: string, timeoutMs: number): Promise<'accepted' | 'rejected' | 'timeout'> => {
    return new Promise(resolve => {
      const requestRef = ref(db, `consultRequests/${doctorId}/${requestId}`);

      const timer = setTimeout(() => {
        unsubscribe();
        resolve('timeout');
      }, timeoutMs);

      const unsubscribe = onValue(requestRef, snap => {
        const data = snap.val();
        if (!data) return;

        if (data.status === 'accepted') {
          clearTimeout(timer);
          unsubscribe();
          resolve('accepted');
        }

        if (data.status === 'rejected') {
          clearTimeout(timer);
          unsubscribe();
          resolve('rejected');
        }
      });
    });
  };


  const sendCallNotification = async (fcmToken: string, patientName: string, roomId: string, requestId: string, origin: string) => {
    console.log('🔔 Sending call notification to token:', fcmToken);
    console.log('    Patient Name:', patientName);
    console.log('    Room ID:', roomId);
    console.log('    Request ID:', requestId);
    console.log('    Origin:', origin);
    try {
      await fetch(notificationServerUrl + '/send-call', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          fcmToken,
          patientName,
          roomId,
          requestId,
          origin,
        }),
      });
    } catch (err) {
      console.error('❌ Failed to send call notification:', err);
    }
  };

  // 1. ใน useEffect ที่รับ message จาก parent (แก้บรรทัดนี้)
  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      const data = event.data;
      console.log("📩 Received Data from Parent:", data);

      if (!data) return;

      if (data.value) {
        const newPatName = data.value || 'unnamed';
        localStorage.setItem('patientName', newPatName);  // เก็บลง localStorage
        setPatName(newPatName);
      }
    };

    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, []);

  // 2. เพิ่ม useEffect ใหม่ เพื่อโหลดจาก localStorage ตอน mount (ใส่หลัง useEffect ข้างบน)
  useEffect(() => {
    const storedName = localStorage.getItem('patientName');
    if (storedName) {
      setPatName(storedName);
      console.log('[PATNAME] Loaded from localStorage:', storedName);
    }
  }, []);  // run ครั้งเดียวตอน mount

  useEffect(() => {
    const raw = localStorage.getItem('selectedLocation');

    if (!raw) {
      setSelectedLocationId(null);
      setSelectedLocation(null);
      return;
    }

    try {
      const parsed = JSON.parse(raw);

      if (parsed?.locationId) {
        setSelectedLocationId(parsed.locationId);
        setSelectedLocation(parsed ? { locationId: parsed.locationId, name: parsed.name } : null);
      } else {
        setSelectedLocationId(null);
      }
    } catch (e) {
      console.error('Invalid selectedLocation in localStorage', e);
      setSelectedLocationId(null);
    }
  }, []);

  useEffect(() => {
    if (!selectedLocationId) {
      setDoctors([]);
      setErrorDoctors(null);
      return;
    }

    setLoadingDoctors(true);
    setErrorDoctors(null);

    const locationDoctorsRef = ref(db, `doctorsByLocation/${selectedLocationId}`);
    const allDoctorsRef = ref(db, 'doctors');

    let locationDataCache: Record<string, any> | null = null;

    const mergeAndUpdate = (realDoctorsData: Record<string, any>) => {
      if (!locationDataCache) return;

      const mergedDoctors: Doctor[] = Object.entries(locationDataCache).map(
        ([id, locDoc]: [string, any]) => {
          const realDoc = realDoctorsData[id] || {};

          return {
            id,
            name: locDoc.name || 'ไม่ระบุชื่อ',
            photoUrl: locDoc.photoUrl || 'https://via.placeholder.com/80',
            specialty: locDoc.specialty || [],
            online: realDoc.online ?? false,
            fcmToken: realDoc.fcmToken ?? null, // ✅ มาจาก doctors/{id}
          };
        }
      );

      setDoctors(mergedDoctors);
      setLoadingDoctors(false);
    };

    const unsubLocation = onValue(
      locationDoctorsRef,
      (snapshot) => {
        locationDataCache = snapshot.val() || {};

        onValue(
          allDoctorsRef,
          (realSnapshot) => {
            const realDoctors = realSnapshot.val() || {};
            mergeAndUpdate(realDoctors);
          },
          { onlyOnce: true }
        );
      },
      (err) => {
        setErrorDoctors(err.message || 'ไม่สามารถดึงข้อมูลแพทย์ได้');
        setLoadingDoctors(false);
      }
    );

    const unsubAllDoctors = onValue(allDoctorsRef, (snapshot) => {
      const realDoctors = snapshot.val() || {};
      if (locationDataCache) {
        mergeAndUpdate(realDoctors);
      }
    });

    return () => {
      unsubLocation();
      unsubAllDoctors();
    };
  }, [selectedLocationId]);


  useEffect(() => {
    if (!activeRoom) return;

    const requestRef = ref(
      db,
      `consultRequests/${activeRoom.doctorId}/${activeRoom.requestId}`
    );

    const unsub = onValue(requestRef, (snap) => {
      const data = snap.val();
      if (!data) return;

      if (data.roomState === 'open') {
        console.log('หมอเปิดห้องแล้ว:', activeRoom.roomId);
        // แค่ปล่อยให้ render สลับหน้า
      }

      if (data.roomState === 'closed') {
        alert('การสนทนาสิ้นสุดแล้ว');
        setActiveRoom(null);

        setTimeout(() => {
          window.location.href = window.location.href +
            (window.location.href.includes('?') ? '&' : '?') +
            '_=' + Date.now();
        }, 100);
      }
    });

    return () => unsub();
  }, [activeRoom]);

  const generateRoomId = () =>
    Math.random().toString(36).substring(2, 8).toUpperCase();

  const handleCall = async (doctor: Doctor) => {
    if (!doctor.online) {
      Swal.fire('แพทย์ไม่ออนไลน์');
      return;
    }

    if (!doctor.fcmToken) {
      Swal.fire('ไม่สามารถติดต่อแพทย์ได้ (ไม่มี token)');
      return;
    }

    const requestId = Date.now().toString();
    const roomId = generateRoomId();
    const patientName = patName;

    console.log('selectedLocation', selectedLocation?.name);
    //const origin = selectedLocation?.name || 'unknown';

    // สร้าง consultRequests ตั้งแต่ต้น (ใช้ร่วมทุก phase)
    await createConsultRequest(
      doctor.id,
      requestId,
      roomId,
      patientName,
      selectedLocation?.name || 'unknown'
    );

    /* =========================
        Phase 1 — API Direct Call
    ========================== */

    Swal.fire({
      title: 'กำลังติดต่อแพทย์',
      text: 'กรุณารอสักครู่...',
      allowOutsideClick: false,
      didOpen: () => Swal.showLoading(),
    });

    try {
      // 👉 Phase 1: โทรแบบ API (ไม่ใช้ FCM)
      const phase1Result = await waitForDoctorResponse(
        doctor.id,
        requestId,
        15000
      );

      if (phase1Result === 'accepted') {
        Swal.close();
        setActiveRoom({
          doctorId: doctor.id,
          doctorName: doctor.name,
          roomId,
          requestId,
          origin: selectedLocation?.name || 'unknown',
        });
        return;
      }
    } catch (e) {
      console.warn('Phase 1 failed');
    }

    /* =========================
        Phase 2 — Firebase + FCM
    ========================== */

    Swal.fire({
      title: 'กำลังติดต่อแพทย์',
      text: 'กรุณารอสักครู่...',
      allowOutsideClick: false,
      didOpen: () => Swal.showLoading(),
    });

    await sendCallNotification(
      doctor.fcmToken,
      patientName,
      roomId,
      requestId,
      selectedLocation?.name || 'unknown'
    );

    const phase2Result = await waitForDoctorResponse(
      doctor.id,
      requestId,
      15000
    );

    if (phase2Result === 'accepted') {
      Swal.close();
      setActiveRoom({
        doctorId: doctor.id,
        doctorName: doctor.name,
        roomId,
        requestId,
        origin: selectedLocation?.name || 'unknown',
      });
      return;
    }

    /* =========================
        ❌ ไม่รับทั้งสอง Phase
    ========================== */

    await update(ref(db, `consultRequests/${doctor.id}/${requestId}`), {
      status: 'rejected',
      roomState: 'closed',
    });

    Swal.fire({
      icon: 'error',
      title: 'ไม่สามารถติดต่อแพทย์ได้',
      text: 'กรุณาลองใหม่อีกครั้ง',
    });
  };



  if (!selectedLocationId) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-100 opacity-95 px-6">
        <div className="flex h-150 w-200 bg-white p-10 rounded-xl shadow-xl text-center items-center justify-center flex-col">
          <h2 className="text-7xl font-bold mb-4">ยังไม่ได้เลือกสถานที่</h2>
          <p className="text-gray-600 mb-6 text-4xl">
            กรุณาไปตั้งค่าสถานที่ก่อนใช้งาน
          </p>
        </div>
      </div>
    );
  }


  if (activeRoom) {
    return (
      <CallRoom
        roomId={activeRoom.roomId}
        doctorName={activeRoom.doctorName}
        onLeave={() => {
          setActiveRoom(null);
          setTimeout(() => {
            window.location.reload();
          }, 100);
        }}
      />
    );
  }


  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 py-16 px-6">
      <div className="max-w-6xl mx-auto">
        <h1 className="text-5xl font-extrabold text-center text-indigo-900 mb-12">
          สวัสดี {patName || "unnamed"}
        </h1>
        <h1 className="text-5xl font-extrabold text-center text-indigo-900 mb-12">
          เลือกแพทย์ที่ต้องการปรึกษา
        </h1>

        {/* <LocationDropdown onSelect={setSelectedLocationId} /> */}

        {selectedLocationId && selectedLocation ? (
          <div className="mt-16">
            <h2 className="text-3xl font-bold text-center text-gray-800 mb-10">
              แพทย์ประจำ {selectedLocation.name}
            </h2>

            {loadingDoctors ? (
              <div className="text-center text-xl text-gray-600 animate-pulse">
                กำลังโหลดรายชื่อแพทย์...
              </div>
            ) : errorDoctors ? (
              <div className="text-center text-xl text-red-600 bg-red-100 p-4 rounded-lg">
                เกิดข้อผิดพลาด: {errorDoctors}
              </div>
            ) : doctors.length === 0 ? (
              <div className="text-center text-xl text-gray-600 bg-gray-100 p-6 rounded-lg">
                ไม่พบแพทย์ที่พร้อมให้คำปรึกษาในขณะนี้
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-10">
                {doctors.map((doctor) => (
                  <div
                    key={doctor.id}
                    className={`bg-white rounded-2xl shadow-xl overflow-hidden transition-all duration-300 transform hover:-translate-y-2 hover:shadow-2xl ${doctor.online ? 'border-2 border-green-500' : 'opacity-75'
                      }`}
                  >
                    <div className="p-8">
                      <div className="flex items-center gap-6 mb-6">
                        <img
                          src={doctor.photoUrl}
                          alt={doctor.name}
                          className="w-24 h-24 rounded-full object-cover border-4 border-indigo-200 shadow-md"
                        />
                        <div>
                          <h3 className="text-2xl font-bold text-gray-900">
                            {doctor.name}
                          </h3>
                          <div className="flex flex-wrap gap-2 mt-2">
                            {doctor.specialty.map((spec, idx) => (
                              <span
                                key={idx}
                                className="inline-block px-4 py-1 bg-indigo-100 text-indigo-800 text-sm font-medium rounded-full"
                              >
                                {spec}
                              </span>
                            ))}
                          </div>
                        </div>
                      </div>

                      <div className="flex items-center gap-3 mb-8">
                        <div
                          className={`w-5 h-5 rounded-full ${doctor.online ? 'bg-green-500 animate-pulse' : 'bg-red-500'
                            }`}
                        />
                        <span
                          className={`text-lg font-semibold ${doctor.online ? 'text-green-700' : 'text-red-700'
                            }`}
                        >
                          {doctor.online ? 'พร้อมให้คำปรึกษา' : 'ออฟไลน์'}
                        </span>
                      </div>

                      <button
                        onClick={() => handleCall(doctor)}
                        disabled={!doctor.online || !doctor.fcmToken}
                        className={`w-full py-4 px-8 rounded-xl font-bold text-lg transition-all ${doctor.online && doctor.fcmToken
                          ? 'bg-indigo-600 hover:bg-indigo-700 text-white shadow-md hover:shadow-lg'
                          : 'bg-gray-300 text-gray-500 cursor-not-allowed'
                          }`}
                      >
                        {doctor.fcmToken ? 'โทรปรึกษา' : 'ไม่พร้อม (ไม่มี token)'}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        ) : (
          <div className="mt-16 text-center text-xl text-gray-600 bg-gray-100 p-8 rounded-2xl">
            กรุณาเลือกสถานที่เพื่อดูรายชื่อแพทย์
          </div>
        )}
      </div>


    </div>
  );
}