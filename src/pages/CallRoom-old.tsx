// import { useEffect, useRef, useState } from 'react';
// import { db } from '../firebase';
// import { ref, set, onValue, onChildAdded } from 'firebase/database';

// type CallRoomProps = {
//   roomId: string;
//   doctorName: string;
//   onLeave: () => void;
// };

// export default function CallRoom({
//   roomId,
//   doctorName,
//   onLeave,
// }: CallRoomProps) {
//   const localVideoRef = useRef<HTMLVideoElement | null>(null);
//   const [localStream, setLocalStream] = useState<MediaStream | null>(null);
//   const pcRef = useRef<RTCPeerConnection | null>(null);
//   const remoteVideoRef = useRef<HTMLVideoElement | null>(null);

//   // 🎥 เปิดกล้อง + ไมค์
//   useEffect(() => {
//     const startCamera = async () => {
//       try {
//         const stream = await navigator.mediaDevices.getUserMedia({
//           video: true,
//           audio: true,
//         });

//         setLocalStream(stream);

//         if (localVideoRef.current) {
//           localVideoRef.current.srcObject = stream;
//         }
//       } catch (err) {
//         console.error('getUserMedia error:', err);
//         alert('ไม่สามารถเปิดกล้องหรือไมโครโฟนได้');
//       }
//     };

//     startCamera();

//     return () => {
//       // cleanup
//       localStream?.getTracks().forEach(t => t.stop());
//     };
//   }, []);

//   useEffect(() => {
//     if (!localStream) return;

//     const pc = new RTCPeerConnection({
//       iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
//     });
//     pcRef.current = pc;

//     // ใส่กล้อง + ไมค์
//     localStream.getTracks().forEach(track => {
//       pc.addTrack(track, localStream);
//     });

//     // รับ stream จาก mobile
//     pc.ontrack = e => {
//       if (remoteVideoRef.current) {
//         remoteVideoRef.current.srcObject = e.streams[0];
//       }
//     };

//     // ส่ง ICE ไป Firebase
//     pc.onicecandidate = e => {
//       if (e.candidate) {
//         set(
//           ref(db, `rooms/${roomId}/candidates/web/${Date.now()}`),
//           e.candidate.toJSON()
//         );
//       }
//     };

//     // สร้าง offer
//     const startCall = async () => {
//       const offer = await pc.createOffer();
//       await pc.setLocalDescription(offer);
//       await set(ref(db, `rooms/${roomId}/offer`), offer);
//     };

//     startCall();

//     return () => pc.close();
//   }, [localStream]);

//   useEffect(() => {
//     const answerRef = ref(db, `rooms/${roomId}/answer`);

//     onValue(answerRef, snap => {
//       const answer = snap.val();
//       if (answer && pcRef.current && !pcRef.current.currentRemoteDescription) {
//         pcRef.current.setRemoteDescription(answer);
//       }
//     });
//   }, []);

//   useEffect(() => {
//     const iceRef = ref(db, `rooms/${roomId}/candidates/mobile`);

//     onChildAdded(iceRef, snap => {
//       pcRef.current?.addIceCandidate(
//         new RTCIceCandidate(snap.val())
//       );
//     });
//   }, []);


//   return (
//     <div className="min-h-screen bg-black flex flex-col">
//       {/* Header */}
//       <div className="p-4 bg-gray-900 text-white flex justify-between items-center">
//         <div>
//           <h1 className="text-xl font-bold">ห้องสนทนา</h1>
//           <p className="text-sm text-gray-300">
//             Room: <span className="font-mono">{roomId}</span>
//           </p>
//         </div>

//         <button
//           onClick={onLeave}
//           className="px-4 py-2 bg-red-600 hover:bg-red-700 rounded-lg font-semibold"
//         >
//           วางสาย
//         </button>
//       </div>

//       {/* Video Area */}
//       <div className="flex-1 relative bg-black">
//         {/* Remote video (หมอ) */}
//         <video
//           ref={remoteVideoRef}
//           autoPlay
//           playsInline
//           className="absolute inset-0 w-full h-full object-cover"
//         />


//         {/* Local preview (ผู้ป่วย) */}
//         <video
//           ref={localVideoRef}
//           autoPlay
//           playsInline
//           muted
//           className="absolute bottom-6 right-6 w-40 h-56 bg-black rounded-xl object-cover"
//         />
//       </div>

//       {/* Footer info */}
//       <div className="p-4 bg-gray-900 text-gray-300 text-center">
//         กำลังสนทนากับแพทย์: <span className="font-semibold">{doctorName}</span>
//       </div>
//     </div>
//   );
// }

import { useEffect, useRef, useState } from 'react';
import { db } from '../firebase';
import { ref, set, onValue, onChildAdded, remove } from 'firebase/database'; // เพิ่ม remove

type CallRoomProps = {
  roomId: string;
  doctorName: string;
  onLeave: () => void;
};

export default function CallRoom({
  roomId,
  doctorName,
  onLeave,
}: CallRoomProps) {
  const localVideoRef = useRef<HTMLVideoElement | null>(null);
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const remoteVideoRef = useRef<HTMLVideoElement | null>(null);

  // 1️⃣ เคลียร์ห้องก่อนเริ่ม (ป้องกันไปหยิบ Answer เก่ามาใช้)
  useEffect(() => {
    const cleanUpRoom = async () => {
      await remove(ref(db, `rooms/${roomId}`));
    };
    cleanUpRoom();
  }, [roomId]);

  // 🎥 เปิดกล้อง + ไมค์
  useEffect(() => {
    const startCamera = async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: true,
          audio: true,
        });

        setLocalStream(stream);

        if (localVideoRef.current) {
          localVideoRef.current.srcObject = stream;
        }
      } catch (err) {
        console.error('getUserMedia error:', err);
        alert('ไม่สามารถเปิดกล้องหรือไมโครโฟนได้');
      }
    };

    startCamera();

    return () => {
      localStream?.getTracks().forEach(t => t.stop());
    };
  }, []);

  useEffect(() => {
    if (!localStream) return;

    const pc = new RTCPeerConnection({
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
    });
    pcRef.current = pc;

    localStream.getTracks().forEach(track => {
      pc.addTrack(track, localStream);
    });

    pc.ontrack = e => {
      if (remoteVideoRef.current) {
        remoteVideoRef.current.srcObject = e.streams[0];
      }
    };

    pc.onicecandidate = e => {
      if (e.candidate) {
        set(
          ref(db, `rooms/${roomId}/candidates/web/${Date.now()}`),
          e.candidate.toJSON()
        );
      }
    };

    // สร้าง offer
    const startCall = async () => {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await set(ref(db, `rooms/${roomId}/offer`), offer);
    };

    startCall();

    return () => pc.close();
  }, [localStream]);

  // ✅ จุดที่แก้: Handle Answer
  useEffect(() => {
    const answerRef = ref(db, `rooms/${roomId}/answer`);

    const unsubscribe = onValue(answerRef, async snap => {
      const answer = snap.val();
      const pc = pcRef.current;

      if (!answer || !pc) return;

      // ✅ เช็ค State: ต้องเป็น 'have-local-offer' เท่านั้น ถึงจะรับ Answer ได้
      // ถ้าเป็น 'stable' แปลว่ายังไม่ได้ทำ Offer หรือทำเสร็จไปแล้ว ห้าม set ซ้ำ
      if (pc.signalingState === 'have-local-offer') {
        try {
          await pc.setRemoteDescription(new RTCSessionDescription(answer));
        } catch (err) {
          console.error('Error setting remote description:', err);
        }
      }
    });

    return () => unsubscribe();
  }, []);

  useEffect(() => {
    const iceRef = ref(db, `rooms/${roomId}/candidates/mobile`);

    const unsubscribe = onChildAdded(iceRef, snap => {
      const candidate = snap.val();
      if (pcRef.current && pcRef.current.remoteDescription) {
         // เพิ่ม Candidate เมื่อ connection พร้อม
         pcRef.current.addIceCandidate(new RTCIceCandidate(candidate));
      }
    });
    
    return () => unsubscribe();
  }, []);

  return (
    <div className="min-h-screen bg-black flex flex-col">
      {/* Header */}
      <div className="p-4 bg-gray-900 text-white flex justify-between items-center">
        <div>
          <h1 className="text-xl font-bold">ห้องสนทนา</h1>
          <p className="text-sm text-gray-300">
            Room: <span className="font-mono">{roomId}</span>
          </p>
        </div>

        <button
          onClick={onLeave}
          className="px-4 py-2 bg-red-600 hover:bg-red-700 rounded-lg font-semibold"
        >
          วางสาย
        </button>
      </div>

      {/* Video Area */}
      <div className="flex-1 relative bg-black">
        {/* Remote video (หมอ) */}
        <video
          ref={remoteVideoRef}
          autoPlay
          playsInline
          className="absolute inset-0 w-full h-full object-cover"
        />

        {/* Local preview (ผู้ป่วย) */}
        <video
          ref={localVideoRef}
          autoPlay
          playsInline
          muted
          className="absolute bottom-6 right-6 w-40 h-56 bg-black rounded-xl object-cover border-2 border-gray-800"
        />
      </div>

      {/* Footer info */}
      <div className="p-4 bg-gray-900 text-gray-300 text-center">
        กำลังสนทนากับแพทย์: <span className="font-semibold">{doctorName}</span>
      </div>
    </div>
  );
}