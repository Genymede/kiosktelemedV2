import { useEffect, useRef, useState } from 'react';
import { db } from '../firebase';
import {
  ref,
  set,
  onValue,
  onChildAdded,
  onDisconnect,
  remove,
  off
} from 'firebase/database';

type CallRoomProps = {
  roomId: string;
  doctorName: string;
  onLeave: () => void;
};

export default function CallRoom({ roomId, doctorName, onLeave }: CallRoomProps) {
  const localVideoRef = useRef<HTMLVideoElement | null>(null);
  const remoteVideoRef = useRef<HTMLVideoElement | null>(null);

  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [isMobileReady, setIsMobileReady] = useState(false);
  const [connectionStatus, setConnectionStatus] = useState('กำลังเตรียมพร้อม...');

  const pcRef = useRef<RTCPeerConnection | null>(null);

  // Configuration สำหรับ WebRTC (Google STUN servers)
  const pcConfig: RTCConfiguration = {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:stun2.l.google.com:19302' },
    ],
  };

  // --------------------------------------------------------
  // 1. Setup Local Media (กล้อง/ไมค์)
  // --------------------------------------------------------
  useEffect(() => {
    let stream: MediaStream | null = null;

    const startCamera = async () => {
      try {
        console.log('[MEDIA] Requesting user media...');
        stream = await navigator.mediaDevices.getUserMedia({
          video: true,
          audio: true,
        });

        setLocalStream(stream);

        // แสดงผล Local Video
        if (localVideoRef.current) {
          localVideoRef.current.srcObject = stream;
          localVideoRef.current.muted = true; // Mute ตัวเองเพื่อกันเสียงสะท้อน
        }
      } catch (err) {
        console.error('[MEDIA] Error accessing media:', err);
        alert('ไม่สามารถเข้าถึงกล้องหรือไมโครโฟนได้ กรุณาตรวจสอบสิทธิ์');
        onLeave(); // เด้งออกถ้าไม่มีกล้อง
      }
    };

    startCamera();

    // Cleanup Media เมื่อ Component ถูกทำลาย
    return () => {
      if (stream) {
        console.log('[MEDIA] Stopping local tracks...');
        stream.getTracks().forEach((track) => track.stop());
      }
    };
  }, []); // Run ครั้งเดียวตอน mount

  // --------------------------------------------------------
  // 2. Main WebRTC Logic (ทำงานเมื่อได้ Local Stream แล้ว)
  // --------------------------------------------------------
  useEffect(() => {
    if (!localStream) return;

    console.log('[WEBRTC] Initializing PeerConnection...');
    setConnectionStatus('กำลังเชื่อมต่อเซิร์ฟเวอร์...');

    // 2.1 สร้าง PeerConnection
    const pc = new RTCPeerConnection(pcConfig);
    pcRef.current = pc;

    // 2.2 Add Tracks (ส่งภาพ/เสียงเราไป)
    localStream.getTracks().forEach((track) => {
      pc.addTrack(track, localStream);
    });

    // 2.3 Handle Remote Stream (รับภาพ/เสียงเขามา)
    pc.ontrack = (event) => {
      console.log('[WEBRTC] Remote track received');
      const remoteStream = event.streams[0];
      if (remoteVideoRef.current && remoteStream) {
        remoteVideoRef.current.srcObject = remoteStream;
      }
    };

    // 2.4 Handle ICE Candidates (ส่งที่อยู่เน็ตเราไป Firebase)
    pc.onicecandidate = (event) => {
      if (event.candidate) {
        set(
          ref(db, `rooms/${roomId}/candidates/web/${Date.now()}`),
          event.candidate.toJSON()
        );
      }
    };

    // Monitor Connection State
    pc.onconnectionstatechange = () => {
      console.log('[WEBRTC] Connection State:', pc.connectionState);
      if (pc.connectionState === 'connected') {
        setConnectionStatus('เชื่อมต่อสำเร็จ');
      } else if (pc.connectionState === 'disconnected') {
        setConnectionStatus('สัญญาณขาดหาย');
      }
    };

    // --------------------------------------------------------
    // Firebase Signaling
    // --------------------------------------------------------

    // A. Setup onDisconnect (กันเหนียวถ้าปิดแท็บ)
    const roomRef = ref(db, `rooms/${roomId}`);
    onDisconnect(roomRef).remove();

    // B. Reset ค่าเก่าในห้องก่อนเริ่ม (Clean Slate)
    set(ref(db, `rooms/${roomId}/offer`), null);
    set(ref(db, `rooms/${roomId}/answer`), null);
    set(ref(db, `rooms/${roomId}/candidates`), null);

    // C. ฟังสถานะ Mobile Ready
    const mobileReadyRef = ref(db, `rooms/${roomId}/mobileReady`);
    const unsubscribeMobileReady = onValue(mobileReadyRef, async (snap) => {
      const isReady = snap.val() === true;
      setIsMobileReady(isReady);

      if (isReady) {
        console.log('[SIGNAL] Mobile is ready. Creating Offer...');
        setConnectionStatus('กำลังโทรหาแพทย์...');

        // สร้าง Offer เฉพาะเมื่อยังไม่มี Offer หรืออยู่ในสถานะ Stable
        if (pc.signalingState === 'stable') {
          try {
            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);

            await set(ref(db, `rooms/${roomId}/offer`), {
              type: offer.type,
              sdp: offer.sdp,
            });
            console.log('[SIGNAL] Offer sent.');
          } catch (err) {
            console.error('[SIGNAL] Error creating offer:', err);
          }
        }
      } else {
        setConnectionStatus('รอแพทย์เข้าห้อง...');
      }
    });

    // D. ฟัง Answer จาก Mobile
    const answerRef = ref(db, `rooms/${roomId}/answer`);
    const unsubscribeAnswer = onValue(answerRef, async (snap) => {
      const data = snap.val();
      if (!pcRef.current || !data) return;

      if (pcRef.current.signalingState === 'have-local-offer') {
        console.log('[SIGNAL] Answer received. Setting Remote Description...');
        try {
          await pcRef.current.setRemoteDescription(new RTCSessionDescription(data));
        } catch (err) {
          console.error('[SIGNAL] Error setting remote description:', err);
        }
      }
    });

    // E. ฟัง ICE Candidates จาก Mobile
    const mobileIceRef = ref(db, `rooms/${roomId}/candidates/mobile`);
    const unsubscribeIce = onChildAdded(mobileIceRef, async (snap) => {
      const data = snap.val();
      if (pcRef.current && data) {
        try {
          await pcRef.current.addIceCandidate(new RTCIceCandidate(data));
        } catch (err) {
          console.error('[SIGNAL] Error adding remote ICE:', err);
        }
      }
    });

    // --------------------------------------------------------
    // Cleanup Function (เมื่อ useEffect นี้ถูกทำลาย)
    // --------------------------------------------------------
    return () => {
      console.log('[WEBRTC] Cleaning up connection...');

      // Stop Listeners
      off(mobileReadyRef);
      off(answerRef);
      off(mobileIceRef);
      unsubscribeMobileReady();
      unsubscribeAnswer();
      unsubscribeIce();

      // Close PC
      if (pcRef.current) {
        pcRef.current.close();
        pcRef.current = null;
      }
    };
  }, [localStream, roomId]); // Dependency: ทำงานเมื่อได้ Stream และ RoomId

  // --------------------------------------------------------
  // Function: วางสาย
  // --------------------------------------------------------
  const handleLeave = async () => {
    console.log('[ACTION] Leaving room...');

    // 1. Cleanup PC
    if (pcRef.current) {
      pcRef.current.close();
      pcRef.current = null;
    }

    // 2. Stop Tracks (ปิดไฟกล้อง)
    if (localStream) {
      localStream.getTracks().forEach((track) => track.stop());
      setLocalStream(null);
    }

    // 3. Clear Firebase Room Data
    try {
      await remove(ref(db, `rooms/${roomId}`));
    } catch (err) {
      console.warn('Firebase remove error:', err);
    }

    // 4. Callback to Parent
    onLeave();
  };

  return (
    <div className="min-h-screen bg-black flex flex-col font-sans">
      {/* Header */}
      <div className="p-4 bg-gray-900 text-white flex justify-between items-center shadow-md z-10">
        <div>
          <h1 className="text-xl font-bold flex items-center gap-2">
            <span className="w-3 h-3 rounded-full bg-green-500 animate-pulse"></span>
            ห้องตรวจออนไลน์
          </h1>
          <p className="text-sm text-gray-400">Room ID: {roomId}</p>
        </div>
        <button
          onClick={handleLeave}
          className="px-6 py-2 bg-red-600 hover:bg-red-700 text-white rounded-full font-semibold transition-colors shadow-lg"
        >
          วางสาย
        </button>
      </div>

      {/* Video Area */}
      <div className="flex-1 relative bg-black overflow-hidden flex justify-center items-center">

        {/* Remote Video (หมอ) - เต็มจอ */}
        <video
          ref={remoteVideoRef}
          autoPlay
          playsInline
          className="absolute inset-0 w-full h-full object-contain bg-black"
        />

        {/* Local Video (เรา) - มุมขวาล่าง */}
        <div className="absolute bottom-6 right-6 w-32 h-48 md:w-48 md:h-64 rounded-xl overflow-hidden border-2 border-gray-700 shadow-2xl z-20 bg-gray-900">
          <video
            ref={localVideoRef}
            autoPlay
            playsInline
            muted // สำคัญ! ต้อง mute ตัวเอง
            className="w-full h-full object-cover transform scale-x-[-1]" // กลับด้านเหมือนกระจก
          />
          <div className="absolute bottom-1 right-2 text-xs text-white bg-black/50 px-1 rounded">
            คุณ
          </div>
        </div>

        {/* Overlay Status Message */}
        {!isMobileReady && (
          <div className="absolute z-10 flex flex-col items-center justify-center text-white bg-black/60 backdrop-blur-sm p-8 rounded-2xl border border-gray-700">
            <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-white mb-4"></div>
            <p className="text-lg font-medium">{connectionStatus}</p>
            <p className="text-sm text-gray-400 mt-2">กำลังรอแพทย์เข้าร่วม...</p>
          </div>
        )}
      </div>

      {/* Footer Info */}
      <div className="p-3 bg-gray-900 text-gray-300 text-center text-sm">
        กำลังสนทนากับ: <span className="font-semibold text-white">{doctorName}</span>
      </div>
    </div>
  );
}