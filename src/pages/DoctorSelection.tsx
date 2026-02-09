import { useState, useEffect } from 'react';
import { ref, onValue, set } from 'firebase/database';
import { db } from '../firebase';
import type { Doctor } from '../types';
import LocationDropdown from '../components/LocationDropdown';
import CallRoom from './CallRoom';
import Swal from 'sweetalert2';

//const NOTI_SERVER_URL = 'https://noti-server.vercel.app';

export default function DoctorSelection() {
  const [selectedLocationId, setSelectedLocationId] = useState<string | null>(null);
  const [doctors, setDoctors] = useState<Doctor[]>([]);
  const [loadingDoctors, setLoadingDoctors] = useState(false);
  const [errorDoctors, setErrorDoctors] = useState<string | null>(null);
  const [activeRoom, setActiveRoom] = useState<{
    doctorName: string;
    roomId: string;
    doctorId: string;
    requestId: string;
  } | null>(null);

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

      const mergedDoctors: Doctor[] = Object.entries(locationDataCache).map(([id, locDoc]) => ({
        id,
        name: locDoc.name || 'ไม่ระบุชื่อ',
        photoUrl: locDoc.photoUrl || 'https://via.placeholder.com/80',
        specialty: locDoc.specialty || [],
        fcmToken: locDoc.fcmToken ?? null,
        online: realDoctorsData[id]?.online ?? false,
      }));

      setDoctors(mergedDoctors);
      setLoadingDoctors(false);
    };

    const unsubLocation = onValue(locationDoctorsRef, (snapshot) => {
      locationDataCache = snapshot.val() || {};

      onValue(allDoctorsRef, (realSnapshot) => {
        const realDoctors = realSnapshot.val() || {};
        mergeAndUpdate(realDoctors);
      }, { onlyOnce: true });
    }, (err) => {
      setErrorDoctors(err.message || 'ไม่สามารถดึงข้อมูลแพทย์ได้');
      setLoadingDoctors(false);
    });

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
          window.location.reload();
        }, 100);
      }
    });

    return () => unsub();
  }, [activeRoom]);


  const generateRoomId = () =>
    Math.random().toString(36).substring(2, 8).toUpperCase();


  // const handleCall = async (doctor: Doctor) => {
  //   if (!doctor.online) {
  //     alert('แพทย์ท่านนี้ไม่ออนไลน์ในขณะนี้');
  //     return;
  //   }

  //   try {
  //     // บันทึกคำขอลง Firebase เพื่อให้แอปหมอเห็น real-time
  //     const requestId = Date.now().toString(); // ใช้ timestamp เป็น ID ชั่วคราว
  //     await set(ref(db, `consultRequests/${doctor.id}/${requestId}`), {
  //       patientName: 'ผู้ป่วย', // หรือดึงจากระบบ auth ถ้ามี
  //       timestamp: Date.now(),
  //       status: 'pending',
  //       type: 'incoming_call'
  //     });

  //     console.log('บันทึกคำขอปรึกษาเรียบร้อย:', requestId);

  //     // (optional) ถ้ายังอยากส่งไป server ด้วย (push แบบเก่า)
  //     const response = await fetch(`${NOTI_SERVER_URL}/send-call-notification`, {
  //       method: 'POST',
  //       headers: { 'Content-Type': 'application/json' },
  //       body: JSON.stringify({
  //         doctorId: doctor.id,
  //         patientName: 'ผู้ป่วย',
  //       }),
  //     });

  //     const result = await response.json();

  //     if (!response.ok) {
  //       console.warn('Server push ล้มเหลว แต่ Firebase real-time ยังทำงานได้:', result);
  //     }

  //     alert(`ส่งคำขอปรึกษาไปยัง ${doctor.name} เรียบร้อยแล้ว!\n(ถ้าแอปหมอเปิดอยู่ จะเห็นแจ้งเตือนทันที)`);

  //   } catch (error: any) {
  //     console.error('Error:', error);
  //     alert(`เกิดข้อผิดพลาด: ${error.message || 'ไม่สามารถส่งคำขอได้ กรุณาลองใหม่'}`);
  //   }
  // };

  const handleCall = async (doctor: Doctor) => {
    if (!doctor.online) {
      alert('แพทย์ท่านนี้ไม่ออนไลน์ในขณะนี้');
      return;
    }

    try {
      const requestId = Date.now().toString();
      const roomId = generateRoomId();

      await set(ref(db, `consultRequests/${doctor.id}/${requestId}`), {
        patientName: 'ผู้ป่วย',
        timestamp: Date.now(),
        status: 'pending',
        type: 'incoming_call',
        roomId,
        roomState: 'waiting', // เริ่มต้น waiting
      });

      console.log('ส่งคำขอพร้อม roomId:', roomId);

      // แสดง modal แบบรอแพทย์รับสาย (ปุ่ม disabled จนกว่าจะ open)
      Swal.fire({
        title: 'รอแพทย์รับสาย',
        html: `ส่งคำขอไปยัง <b>${doctor.name}</b> แล้ว<br>Room: <b>${roomId}</b><br>กรุณารอสักครู่...`,
        allowOutsideClick: false,
        allowEscapeKey: false,
        showConfirmButton: true,
        confirmButtonText: 'รอแพทย์รับสาย...', // ปุ่ม disabled เริ่มต้น
        confirmButtonColor: '#6b7280', // สีเทา (disabled look)
        didOpen: () => {
          const confirmButton = Swal.getConfirmButton();
          if (confirmButton) {
            confirmButton.disabled = true; // disable ปุ่มตั้งแต่แรก
          }
        }
      });

      // ฟัง roomState แบบ real-time
      const requestRef = ref(db, `consultRequests/${doctor.id}/${requestId}`);
      const unsubscribe = onValue(requestRef, (snap) => {
        const data = snap.val();
        if (!data) return;

        if (data.roomState === 'accepted') {
          Swal.update({
            title: 'แพทย์รับสายแล้ว!',
            html: 'กำลังเชื่อมต่อห้องสนทนา...',
            confirmButtonText: 'กำลังเชื่อมต่อ...'
          });
        }

        if (data.roomState === 'open') {
          Swal.close(); // ปิด modal
          setActiveRoom({
            doctorName: doctor.name,
            roomId,
            doctorId: doctor.id,
            requestId,
          });
          unsubscribe(); // หยุดฟัง
        }

        if (data.roomState === 'closed' || data.status === 'rejected') {
          Swal.fire({
            icon: 'error',
            title: 'การสนทนาสิ้นสุดแล้ว',
            text: 'แพทย์ปฏิเสธหรือปิดห้อง',
          });
          setActiveRoom(null);
          unsubscribe();
        }
      });

    } catch (error: any) {
      console.error('Error:', error);
      Swal.fire({
        icon: 'error',
        title: 'เกิดข้อผิดพลาด',
        text: error.message || 'ไม่สามารถส่งคำขอได้'
      });
    }
  };

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
          เลือกแพทย์ที่ต้องการปรึกษา
        </h1>

        <LocationDropdown onSelect={setSelectedLocationId} />

        {selectedLocationId ? (
          <div className="mt-16">
            <h2 className="text-3xl font-bold text-center text-gray-800 mb-10">
              แพทย์ประจำสถานที่นี้
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
                    className={`bg-white rounded-2xl shadow-xl overflow-hidden transition-all duration-300 transform hover:-translate-y-2 hover:shadow-2xl ${
                      doctor.online ? 'border-2 border-green-500' : 'opacity-75'
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
                          className={`w-5 h-5 rounded-full ${
                            doctor.online ? 'bg-green-500 animate-pulse' : 'bg-red-500'
                          }`}
                        />
                        <span
                          className={`text-lg font-semibold ${
                            doctor.online ? 'text-green-700' : 'text-red-700'
                          }`}
                        >
                          {doctor.online ? 'พร้อมให้คำปรึกษา' : 'ออฟไลน์'}
                        </span>
                      </div>

                      <button
                        onClick={() => handleCall(doctor)}
                        disabled={!doctor.online || !doctor.fcmToken}
                        className={`w-full py-4 px-8 rounded-xl font-bold text-lg transition-all ${
                          doctor.online && doctor.fcmToken
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