import { useEffect, useRef, useState } from 'react';
import { db } from '../firebase';
import { ref, set, onValue, onChildAdded, remove, off } from 'firebase/database';

type CallRoomProps = {
  roomId: string;
  doctorName: string;
  onLeave: () => void;
};

const pcConfig: RTCConfiguration = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ],
};

export default function CallRoom({ roomId, doctorName, onLeave }: CallRoomProps) {
  const localVideoRef = useRef<HTMLVideoElement | null>(null);
  const remoteVideoRef = useRef<HTMLVideoElement | null>(null);

  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [isMobileReady, setIsMobileReady] = useState(false);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null); // เพิ่ม State เพื่อ trigger render remote video

  const pcRef = useRef<RTCPeerConnection | null>(null);

  // 1. Initial Setup & Cleanup Firebase
  useEffect(() => {
    const initRoom = async () => {
      console.log('[ROOM] Initializing room:', roomId);
      const base = `rooms/${roomId}`;
      // ล้างค่าเก่าก่อนเริ่ม
      await remove(ref(db, `${base}/offer`));
      await remove(ref(db, `${base}/answer`));
      await remove(ref(db, `${base}/candidates`));
    };
    initRoom();

    // Cleanup เมื่อ Component ถูกทำลาย (ปิดกล้องที่นี่ชัวร์สุด)
    return () => {
      if (localStream) {
        localStream.getTracks().forEach(t => t.stop());
      }
      if (pcRef.current) {
        pcRef.current.close();
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId]);

  // 2. Setup Camera
  useEffect(() => {
    const startCamera = async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: true,
          audio: true,
        });
        setLocalStream(stream);

        // Assign ให้ video element ทันที
        if (localVideoRef.current) {
          localVideoRef.current.srcObject = stream;
        }
      } catch (err) {
        console.error('Error accessing media devices:', err);
        alert('ไม่สามารถเข้าถึงกล้องหรือไมโครโฟนได้');
      }
    };

    if (!localStream) {
      startCamera();
    }
  }, [localStream]);

  // 3. Setup PeerConnection (เมื่อมี LocalStream แล้วเท่านั้น)
  useEffect(() => {
    if (!localStream || pcRef.current) return; // สร้างครั้งเดียวพอ

    console.log('[WebRTC] Creating PeerConnection');
    const pc = new RTCPeerConnection(pcConfig);
    pcRef.current = pc;

    // Add Local Tracks
    localStream.getTracks().forEach((track) => {
      pc.addTrack(track, localStream);
    });

    // Handle Remote Stream
    pc.ontrack = (event) => {
      const stream = event.streams[0];
      if (stream) {
        console.log('[WebRTC] Remote stream received');
        setRemoteStream(stream); // Set state เพื่อให้ UI update
        if (remoteVideoRef.current) {
          remoteVideoRef.current.srcObject = stream;
        }
      }
    };

    // Send ICE Candidates
    pc.onicecandidate = (event) => {
      if (event.candidate) {
        set(ref(db, `rooms/${roomId}/candidates/web/${Date.now()}`), event.candidate.toJSON());
      }
    };

    // Receive ICE Candidates from Mobile
    const candidatesRef = ref(db, `rooms/${roomId}/candidates/mobile`);
    const onCandidateAdded = onChildAdded(candidatesRef, (snapshot) => {
      const data = snapshot.val();
      if (data && pcRef.current && pcRef.current.remoteDescription) {
        pcRef.current.addIceCandidate(new RTCIceCandidate(data)).catch(console.error);
      }
    });

    return () => {
      off(candidatesRef, 'child_added', onCandidateAdded);
    };
  }, [localStream, roomId]);

  // 4. Monitor Mobile Ready & Create Offer
  useEffect(() => {
    const readyRef = ref(db, `rooms/${roomId}/mobileReady`);

    const unsubscribe = onValue(readyRef, async (snapshot) => {
      const ready = snapshot.val() === true;
      setIsMobileReady(ready);

      // ถ้า Mobile พร้อม และ PC พร้อม และยังไม่มี Offer -> สร้าง Offer
      if (ready && pcRef.current && pcRef.current.signalingState === 'stable') {
        // เช็คว่าเคยส่ง offer ไปแล้วหรือยัง (เช็คจาก DB กันพลาด)
        // แต่ใน logic นี้เราจะ create offer ใหม่ถ้า mobile active
        console.log('[Signaling] Creating Offer...');
        try {
          const offer = await pcRef.current.createOffer();
          await pcRef.current.setLocalDescription(offer);

          await set(ref(db, `rooms/${roomId}/offer`), {
            type: offer.type,
            sdp: offer.sdp
          });
        } catch (err) {
          console.error('Error creating offer:', err);
        }
      }
    });

    return () => unsubscribe();
  }, [roomId, localStream]); // เพิ่ม localStream เพื่อให้มั่นใจว่า PC ถูกสร้างก่อน

  // 5. Monitor Answer
  useEffect(() => {
    const answerRef = ref(db, `rooms/${roomId}/answer`);

    const unsubscribe = onValue(answerRef, async (snapshot) => {
      const data = snapshot.val();
      if (!pcRef.current || !data) return;

      if (pcRef.current.signalingState === 'have-local-offer') {
        console.log('[Signaling] Set Remote Description (Answer)');
        try {
          await pcRef.current.setRemoteDescription(new RTCSessionDescription(data));
        } catch (err) {
          console.error('Error setting remote description:', err);
        }
      }
    });

    return () => unsubscribe();
  }, [roomId]);

  // Effect พิเศษ: Sync Remote Video เมื่อ State เปลี่ยน (ป้องกันจอดำ)
  useEffect(() => {
    if (remoteVideoRef.current && remoteStream) {
      remoteVideoRef.current.srcObject = remoteStream;
    }
  }, [remoteStream]);

  const handleLeave = async () => {
    // 1. Stop Local Tracks
    if (localStream) {
      localStream.getTracks().forEach((track) => track.stop());
      setLocalStream(null);
    }

    // 2. Close PC
    if (pcRef.current) {
      pcRef.current.close();
      pcRef.current = null;
    }

    // 3. Clear Firebase data
    await remove(ref(db, `rooms/${roomId}`));

    // 4. Navigate out
    onLeave();
  };

  return (
    <div className="min-h-screen bg-black flex flex-col">
      {/* Header */}
      <div className="p-4 bg-gray-900 text-white flex justify-between items-center z-10 shadow-md">
        <div>
          <h1 className="text-xl font-bold">ห้องตรวจรักษากระดูก</h1>
          <p className="text-sm text-gray-400">Room ID: {roomId}</p>
        </div>
        <button
          onClick={handleLeave}
          className="px-6 py-2 bg-red-600 hover:bg-red-700 rounded-full font-semibold transition-colors shadow-lg"
        >
          วางสาย
        </button>
      </div>

      {/* Main Video Area */}
      <div className="flex-1 relative bg-gray-900 overflow-hidden flex items-center justify-center">
        {/* Remote Video (Doctor) */}
        {remoteStream ? (
          <video
            ref={remoteVideoRef}
            autoPlay
            playsInline
            className="w-full h-full object-contain"
          />
        ) : (
          <div className="text-gray-500 flex flex-col items-center">
            <div className="animate-pulse mb-2">📡</div>
            <p>{isMobileReady ? 'กำลังเชื่อมต่อสัญญาณภาพ...' : 'รอแพทย์เข้าห้องตรวจ...'}</p>
          </div>
        )}

        {/* Local Video (Patient - PIP) */}
        <div className="absolute bottom-6 right-6 w-32 h-48 md:w-48 md:h-64 bg-black rounded-xl overflow-hidden shadow-2xl border-2 border-gray-800">
          <video
            ref={localVideoRef}
            autoPlay
            playsInline
            muted
            className="w-full h-full object-cover transform scale-x-[-1]" // กลับด้านกระจกเงา
          />
          <div className="absolute bottom-2 left-2 text-xs text-white bg-black/60 px-2 py-1 rounded">
            คุณ
          </div>
        </div>
      </div>

      {/* Footer Status */}
      <div className="p-3 bg-gray-800 text-gray-300 text-center text-sm">
        {isMobileReady
          ? <span className="text-green-400">● แพทย์อยู่ในห้องแล้ว</span>
          : <span className="text-yellow-400">● รอแพทย์ตอบรับ...</span>
        }
        <span className="mx-2">|</span>
        แพทย์: {doctorName}
      </div>
    </div>
  );
}