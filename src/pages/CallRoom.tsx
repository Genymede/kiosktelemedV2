import { useEffect, useRef, useState } from 'react';
import { db } from '../firebase';
import {
  ref,
  set,
  onValue,
  onChildAdded,
  onDisconnect,
  remove,
  off,
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

  // Configuration WebRTC - เพิ่ม TURN servers หลายตัวเพื่อแก้ปัญหา NAT/Firewall
  const pcConfig: RTCConfiguration = {
    iceServers: [
      // STUN servers (ฟรีจาก Google)
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:stun2.l.google.com:19302' },

      // TURN servers ฟรีจาก openrelay (ใช้งานได้ดีในไทยปี 2025-2026)
      {
        urls: ['turn:openrelay.metered.ca:80', 'turn:openrelay.metered.ca:443?transport=tcp'],
        username: 'openrelayproject',
        credential: 'openrelayproject',
      },
      // ถ้าต้องการเพิ่มตัวอื่น (มี quota) สามารถใส่เพิ่มได้
      // {
      //   urls: 'turn:your-turn-server.com:3478',
      //   username: 'xxx',
      //   credential: 'yyy',
      // },
    ],
    iceTransportPolicy: 'all', // หรือเปลี่ยนเป็น 'relay' ถ้าต้องการบังคับใช้ TURN เท่านั้น (ช้ากว่าแต่เสถียรกว่า)
  };

  // 1. Setup Local Media
  useEffect(() => {
    let stream: MediaStream | null = null;

    const startCamera = async () => {
      try {
        console.log('[MEDIA] Requesting user media...');
        stream = await navigator.mediaDevices.getUserMedia({
          video: { width: { ideal: 1280 }, height: { ideal: 720 } },
          audio: true,
        });

        setLocalStream(stream);

        if (localVideoRef.current) {
          localVideoRef.current.srcObject = stream;
          localVideoRef.current.muted = true;
        }
      } catch (err) {
        console.error('[MEDIA] Error accessing media:', err);
        alert('ไม่สามารถเข้าถึงกล้องหรือไมโครโฟนได้ กรุณาตรวจสอบสิทธิ์');
        onLeave();
      }
    };

    startCamera();

    return () => {
      if (stream) {
        console.log('[MEDIA] Stopping local tracks...');
        stream.getTracks().forEach((track) => track.stop());
      }
    };
  }, [onLeave]);

  // 2. Main WebRTC Logic
  useEffect(() => {
    if (!localStream) return;

    console.log('[WEBRTC] Initializing PeerConnection...');
    setConnectionStatus('กำลังเชื่อมต่อเซิร์ฟเวอร์...');

    const pc = new RTCPeerConnection(pcConfig);
    pcRef.current = pc;

    // Add local tracks
    localStream.getTracks().forEach((track) => {
      pc.addTrack(track, localStream);
    });

    // Receive remote stream
    pc.ontrack = (event) => {
      console.log('[WEBRTC] Remote track received', event.streams[0]);
      if (remoteVideoRef.current) {
        remoteVideoRef.current.srcObject = event.streams[0];
      }
    };

    // ICE candidate
    pc.onicecandidate = (event) => {
      if (event.candidate) {
        console.log('[ICE] Local candidate generated:', event.candidate.type);
        set(ref(db, `rooms/${roomId}/candidates/web/${Date.now()}`), event.candidate.toJSON());
      }
    };

    // Debug ICE errors
    pc.onicecandidateerror = (event) => {
      console.error('[ICE ERROR]', event.errorCode, event.errorText, event.url);
    };

    // ICE connection state (สำคัญมาก!)
    pc.oniceconnectionstatechange = () => {
      console.log('[ICE conn state]', pc.iceConnectionState);
      if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') {
        setConnectionStatus('เชื่อมต่อสำเร็จ ✓');
      } else if (pc.iceConnectionState === 'failed') {
        setConnectionStatus('การเชื่อมต่อล้มเหลว (อาจเกิดจาก NAT/Firewall)');
        console.warn('ICE failed → พยายาม restart ICE');
        pc.restartIce(); // พยายามเริ่ม ICE ใหม่
      } else if (pc.iceConnectionState === 'disconnected') {
        setConnectionStatus('สัญญาณขาดหาย...');
      }
    };

    pc.onconnectionstatechange = () => {
      console.log('[PC conn state]', pc.connectionState);
    };

    // Firebase Signaling
    const roomRef = ref(db, `rooms/${roomId}`);
    onDisconnect(roomRef).remove();

    // Reset old data
    set(ref(db, `rooms/${roomId}/offer`), null);
    set(ref(db, `rooms/${roomId}/answer`), null);
    set(ref(db, `rooms/${roomId}/candidates`), null);

    // Listen mobile ready
    const mobileReadyRef = ref(db, `rooms/${roomId}/mobileReady`);
    const unsubscribeMobileReady = onValue(mobileReadyRef, async (snap) => {
      const isReady = snap.val() === true;
      setIsMobileReady(isReady);

      if (isReady && pc.signalingState === 'stable') {
        console.log('[SIGNAL] Mobile ready → Creating Offer');
        setConnectionStatus('กำลังโทรหาแพทย์...');

        try {
          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          await set(ref(db, `rooms/${roomId}/offer`), {
            type: offer.type,
            sdp: offer.sdp,
          });
          console.log('[SIGNAL] Offer sent');
        } catch (err) {
          console.error('[SIGNAL] Offer error:', err);
        }
      } else if (!isReady) {
        setConnectionStatus('รอแพทย์เข้าห้อง...');
      }
    });

    // Listen answer
    const answerRef = ref(db, `rooms/${roomId}/answer`);
    const unsubscribeAnswer = onValue(answerRef, async (snap) => {
      const data = snap.val();
      if (!data || pc.signalingState !== 'have-local-offer') return;

      console.log('[SIGNAL] Answer received');
      try {
        await pc.setRemoteDescription(new RTCSessionDescription(data));
      } catch (err) {
        console.error('[SIGNAL] Set remote desc error:', err);
      }
    });

    // Listen mobile ICE candidates
    const mobileIceRef = ref(db, `rooms/${roomId}/candidates/mobile`);
    const unsubscribeIce = onChildAdded(mobileIceRef, async (snap) => {
      const data = snap.val();
      if (!data) return;
      try {
        await pc.addIceCandidate(new RTCIceCandidate(data));
        console.log('[ICE] Added remote candidate');
      } catch (err) {
        console.error('[ICE] Add candidate error:', err);
      }
    });

    return () => {
      console.log('[WEBRTC] Cleaning up...');
      off(mobileReadyRef);
      off(answerRef);
      off(mobileIceRef);
      unsubscribeMobileReady();
      unsubscribeAnswer();
      unsubscribeIce();

      if (pcRef.current) {
        pcRef.current.close();
        pcRef.current = null;
      }
    };
  }, [localStream, roomId, onLeave]);

  const handleLeave = async () => {
    console.log('[ACTION] Leaving room...');

    if (pcRef.current) {
      pcRef.current.close();
      pcRef.current = null;
    }

    if (localStream) {
      localStream.getTracks().forEach((track) => track.stop());
      setLocalStream(null);
    }

    try {
      await remove(ref(db, `rooms/${roomId}`));
    } catch (err) {
      console.warn('[FIREBASE] Remove room error:', err);
    }

    onLeave();
  };

  return (
    <div className="min-h-screen bg-black flex flex-col font-sans">
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

      <div className="flex-1 relative bg-black overflow-hidden flex justify-center items-center">
        <video
          ref={remoteVideoRef}
          autoPlay
          playsInline
          className="absolute inset-0 w-full h-full object-contain bg-black"
        />

        <div className="absolute bottom-6 right-6 w-32 h-48 md:w-48 md:h-64 rounded-xl overflow-hidden border-2 border-gray-700 shadow-2xl z-20 bg-gray-900">
          <video
            ref={localVideoRef}
            autoPlay
            playsInline
            muted
            className="w-full h-full object-cover transform scale-x-[-1]"
          />
          <div className="absolute bottom-1 right-2 text-xs text-white bg-black/50 px-1 rounded">
            คุณ
          </div>
        </div>

        {/* Status overlay */}
        <div className="absolute z-10 flex flex-col items-center justify-center text-white bg-black/60 backdrop-blur-sm p-8 rounded-2xl border border-gray-700">
          {!isMobileReady || connectionStatus.includes('ล้มเหลว') ? (
            <>
              <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-white mb-4"></div>
              <p className="text-lg font-medium">{connectionStatus}</p>
              <p className="text-sm text-gray-400 mt-2">
                {connectionStatus.includes('ล้มเหลว')
                  ? 'กรุณาตรวจสอบเน็ต หรือลองใช้ Wi-Fi อื่น'
                  : 'กำลังรอแพทย์เข้าร่วม...'}
              </p>
            </>
          ) : null}
        </div>
      </div>

      <div className="p-3 bg-gray-900 text-gray-300 text-center text-sm">
        กำลังสนทนากับ: <span className="font-semibold text-white">{doctorName}</span>
      </div>
    </div>
  );
}