// src/pages/CallRoom.tsx
import { useEffect, useRef, useState } from 'react';
import { db } from '../firebase';
import { ref, set, onValue, onChildAdded, remove } from 'firebase/database';

type CallRoomProps = {
  roomId: string;
  doctorName: string;
  onLeave: () => void;
};

export default function CallRoom({ roomId, doctorName, onLeave }: CallRoomProps) {
  const localVideoRef = useRef<HTMLVideoElement | null>(null);
  const remoteVideoRef = useRef<HTMLVideoElement | null>(null);

  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const offerSentRef = useRef(false);

  // const pcConfig: RTCConfiguration = {
  //   iceServers: [
  //     { urls: 'stun:stun.l.google.com:19302' },
  //     { urls: 'stun:stun1.l.google.com:19302' },
  //   ],
  // };

  const pcConfig: RTCConfiguration = {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      {
        urls: [
          'turn:openrelay.metered.ca:80',
          'turn:openrelay.metered.ca:443?transport=tcp',
          'turns:openrelay.metered.ca:443?transport=tcp',
        ],
        username: 'openrelayproject',
        credential: 'openrelayproject',
      },
    ],
    iceTransportPolicy: 'all', // หรือลอง 'relay' ถ้าอยากบังคับ TURN
  };

  // 0) optional: เคลียร์ของเก่าแบบ "ปลอดภัย"
  //    (ลบเฉพาะ offer/answer/candidates ไม่ลบทั้งห้อง)
  useEffect(() => {
    const base = `rooms/${roomId}`;
    console.log('[ROOM] init cleanup (safe):', roomId);

    // ล้างสัญญาณเก่า (ปลอดภัย)
    remove(ref(db, `${base}/offer`));
    remove(ref(db, `${base}/answer`));
    remove(ref(db, `${base}/candidates`));
    // ไม่ลบ mobileReady เพราะให้หมอเป็นคน set ใหม่เองได้

    offerSentRef.current = false;
  }, [roomId]);

  // 1) เปิดกล้อง + ไมค์
  useEffect(() => {
    const startCamera = async () => {
      try {
        console.log('[WEB][CAMERA] requesting media...');
        const stream = await navigator.mediaDevices.getUserMedia({
          video: true,
          audio: true,
        });

        setLocalStream(stream);

        if (localVideoRef.current) {
          localVideoRef.current.srcObject = stream;
          console.log('[WEB][CAMERA] local preview ready');
        }
      } catch (err) {
        console.error('[WEB][CAMERA] error:', err);
        alert('ไม่สามารถเปิดกล้องหรือไมโครโฟนได้');
      }
    };

    startCamera();

    return () => {
      console.log('[WEB][CAMERA] cleanup local stream');
      localStream?.getTracks().forEach((t) => t.stop());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 2) สร้าง PeerConnection ทันทีเมื่อมี localStream
  useEffect(() => {
    if (!localStream) return;

    console.log('[WEBRTC][WEB] create peerconnection');
    const pc = new RTCPeerConnection(pcConfig);
    pcRef.current = pc;

    // add tracks
    localStream.getTracks().forEach((track) => {
      pc.addTrack(track, localStream);
      console.log('[WEBRTC][WEB] addTrack:', track.kind);
    });

    // remote track
    pc.ontrack = (event) => {
      const stream = event.streams?.[0];
      if (!stream) return;
      console.log('[WEBRTC][WEB] ontrack remote stream received');

      if (remoteVideoRef.current) {
        remoteVideoRef.current.srcObject = stream;
      }
    };

    // send ICE (web)
    pc.onicecandidate = (event) => {
      if (event.candidate) {
        set(
          ref(db, `rooms/${roomId}/candidates/web/${Date.now()}`),
          event.candidate.toJSON()
        );
      }
    };

    pc.oniceconnectionstatechange = () => {
      console.log('[WEBRTC][WEB] iceConnectionState:', pc.iceConnectionState);
    };
    pc.onsignalingstatechange = () => {
      console.log('[WEBRTC][WEB] signalingState:', pc.signalingState);
    };

    pc.onicegatheringstatechange = () => {
      console.log('[ICE] gatheringState:', pc.iceGatheringState); // new, complete, gathering
    };

    pc.onicecandidateerror = (e) => {
      console.error('[ICE ERROR]', e.errorCode, e.errorText, e.url);
    };

    pc.oniceconnectionstatechange = () => {
      console.log('[ICE conn]', pc.iceConnectionState);
      if (pc.iceConnectionState === 'failed') {
        console.warn('ICE failed - ลอง restartIce หรือเช็ค firewall/TURN');
        pc.restartIce(); // ลองเรียกดู
      }
    };

    return () => {
      console.log('[WEBRTC][WEB] cleanup pc');
      pc.close();
      pcRef.current = null;
    };
  }, [localStream, roomId]);

  // 3) รอ mobileReady แล้วค่อยสร้าง offer (แก้ปัญหาต้อง refresh)
  useEffect(() => {
    const readyRef = ref(db, `rooms/${roomId}/mobileReady`);

    const unsubscribe = onValue(readyRef, async (snap) => {
      const ready = snap.val() === true;
      const pc = pcRef.current;

      if (!ready || !pc) return;
      if (offerSentRef.current) return; // กันยิงซ้ำ
      if (pc.signalingState !== 'stable') return;

      try {
        console.log('[SIGNAL][WEB] mobileReady=true -> createOffer');

        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);

        await set(ref(db, `rooms/${roomId}/offer`), {
          type: offer.type,
          sdp: offer.sdp,
        });

        offerSentRef.current = true;
        console.log('[SIGNAL][WEB] offer saved');
      } catch (err) {
        console.error('[SIGNAL][WEB] createOffer error:', err);
      }
    });

    return () => unsubscribe();
  }, [roomId]);

  // 4) ฟัง answer
  useEffect(() => {
    const answerRef = ref(db, `rooms/${roomId}/answer`);

    const unsubscribe = onValue(answerRef, async (snap) => {
      const pc = pcRef.current;
      const data = snap.val();

      if (!pc || !data) return;
      if (pc.currentRemoteDescription) return;

      try {
        console.log('[SIGNAL][WEB] got answer -> setRemoteDescription');
        await pc.setRemoteDescription(new RTCSessionDescription(data));
      } catch (err) {
        console.error('[SIGNAL][WEB] setRemoteDescription(answer) error:', err);
      }
    });

    return () => unsubscribe();
  }, [roomId]);

  // 5) รับ ICE จาก mobile
  useEffect(() => {
    const iceRef = ref(db, `rooms/${roomId}/candidates/mobile`);

    const unsubscribe = onChildAdded(iceRef, async (snap) => {
      const pc = pcRef.current;
      if (!pc) return;

      const cand = snap.val();
      try {
        await pc.addIceCandidate(new RTCIceCandidate(cand));
      } catch (err) {
        console.error('[ICE][WEB] addIceCandidate error:', err);
      }
    });

    return () => unsubscribe();
  }, [roomId]);

  // 6) ออกจากห้อง
  const handleLeave = async () => {
    try {
      console.log('[WEB] leaving room');

      // 1️⃣ ถอด track ออกจาก PeerConnection ก่อน (สำคัญมาก)
      if (pcRef.current) {
        pcRef.current.getSenders().forEach(sender => {
          if (sender.track) {
            sender.track.stop();   // 🔥 stop ที่ sender
            pcRef.current?.removeTrack(sender);
          }
        });

        pcRef.current.ontrack = null;
        pcRef.current.onicecandidate = null;
        pcRef.current.close();
        pcRef.current = null;
      }

      // 2️⃣ stop localStream tracks (เผื่อมี track ค้าง)
      if (localStream) {
        localStream.getTracks().forEach(track => {
          track.stop();
        });
        setLocalStream(null);
      }

      // 3️⃣ clear video elements
      if (localVideoRef.current) {
        localVideoRef.current.pause();
        localVideoRef.current.srcObject = null;
      }
      if (remoteVideoRef.current) {
        remoteVideoRef.current.pause();
        remoteVideoRef.current.srcObject = null;
      }

      // 4️⃣ ล้าง signaling
      await remove(ref(db, `rooms/${roomId}/offer`));
      await remove(ref(db, `rooms/${roomId}/answer`));
      await remove(ref(db, `rooms/${roomId}/candidates`));
      await remove(ref(db, `rooms/${roomId}/mobileReady`));

      console.log('[WEB] cleanup done – camera should be OFF');
    } catch (e) {
      console.warn('[WEB] leave cleanup err', e);
    }

    onLeave();
  };



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
          onClick={handleLeave}
          className="px-4 py-2 bg-red-600 hover:bg-red-700 rounded-lg font-semibold"
        >
          วางสาย
        </button>
      </div>

      {/* Video Area */}
      <div className="flex-1 relative bg-black">
        {/* Remote */}
        <video
          ref={remoteVideoRef}
          autoPlay
          playsInline
          className="absolute inset-0 w-full h-full object-fit-cover"
        />

        {/* Local preview */}
        <video
          ref={localVideoRef}
          autoPlay
          playsInline
          muted
          className="absolute bottom-6 right-6 w-40 h-56 rounded-xl object-cover border-2 border-gray-800"
        />
      </div>

      {/* Footer */}
      <div className="p-4 bg-gray-900 text-gray-300 text-center">
        กำลังสนทนากับแพทย์: <span className="font-semibold">{doctorName}</span>
      </div>
    </div>
  );
}
