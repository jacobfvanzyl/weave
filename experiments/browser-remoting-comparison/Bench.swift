import Foundation
import LiveKitWebRTC
import CoreImage
import ImageIO
import Darwin

func now() -> Double { ProcessInfo.processInfo.systemUptime }
func record(_ value: [String:Any]) { if let d=try? JSONSerialization.data(withJSONObject:value,options:[.sortedKeys]),let s=String(data:d,encoding:.utf8){print(s);fflush(stdout)} }
final class Bench: NSObject, LKRTCVideoRenderer {
    var send: (([String:Any])->Void)?
    var phase = -1, counter=0, expected = -1, clicks=0, frames=0, dpr=1
    var start=now(), phaseAt=now(), sentAt=0.0, lastClick=0.0, lastStats=0.0
    var started=false, saved=false
    var latest: LKRTCVideoFrame?
    var timer: Timer?
    let lock=NSLock()
    override init(){super.init();timer=Timer.scheduledTimer(withTimeInterval:0.01,repeats:true){[weak self] _ in self?.tick()}}
    func setSize(_ size: CGSize){}
    func renderFrame(_ frame: LKRTCVideoFrame?){
        guard let frame else{return}; let at=now();let buf=frame.buffer.toI420();let converted=now();let d=Int(frame.width)/960
        guard d>0,frame.height>70*d else{return};guard buf.dataY[(58*d)*Int(buf.strideY)+(8+360+6)*d]>128 else{return};var bits:UInt32=0
        for i in 0..<28 { if buf.dataY[(58*d)*Int(buf.strideY)+(8+i*12+6)*d]>128 {bits |= 1 << i} }
        let p=Int((bits>>8)&15),c=Int(bits&255);guard p<=7 else{return}
        lock.lock();defer{lock.unlock()};latest=frame;dpr=d
        if p != phase{phase=p;phaseAt=at;record(["event":"phase","phase":p,"t":at,"width":frame.width,"height":frame.height])}
        if expected>=0 && c==expected {record(["event":"latency","phase":p,"counter":c,"ms":(at-sentAt)*1000]);expected = -1}
        counter=c;frames+=1;record(["event":"frame","t":at,"phase":p,"sequence":bits>>12,"probeConversionMs":(converted-at)*1000])
    }
    func tick(){lock.lock();defer{lock.unlock()};let at=now()
        if !started && frames>0 && at-start>2{started=true;send?(["type":"click","x":40,"y":20])}
        if phase==2 && at-lastClick>0.6 && clicks<24 && expected<0 {expected=(counter+1)&255;sentAt=at;lastClick=at;clicks+=1;send?(["type":"click","x":540,"y":20])}
        if expected>=0 && at-sentAt>2 {record(["event":"input-timeout","counter":expected]);expected = -1}
        if at-lastStats>1 {lastStats=at;var ru=rusage();getrusage(RUSAGE_SELF,&ru);let cpu=Double(ru.ru_utime.tv_sec)+Double(ru.ru_stime.tv_sec)+Double(ru.ru_utime.tv_usec+ru.ru_stime.tv_usec)/1e6
            var info=mach_task_basic_info();var count=mach_msg_type_number_t(MemoryLayout<mach_task_basic_info>.size/MemoryLayout<integer_t>.size)
            _ = withUnsafeMutablePointer(to:&info){ptr in ptr.withMemoryRebound(to:integer_t.self,capacity:Int(count)){task_info(mach_task_self_,task_flavor_t(MACH_TASK_BASIC_INFO),$0,&count)}}
            record(["event":"stats","t":at,"phase":phase,"frames":frames,"cpuSeconds":cpu,"rssBytes":info.resident_size])
        }
        if phase==6 && at-phaseAt>2 && !saved,let f=latest {saved=true
            if let cv=f.buffer as? LKRTCCVPixelBuffer {let ci=CIImage(cvPixelBuffer:cv.pixelBuffer);let context=CIContext();if let image=context.createCGImage(ci,from:ci.extent){let path=ProcessInfo.processInfo.environment["BENCH_SNAPSHOT"] ?? NSTemporaryDirectory()+"webrtc-quality.png";if let dest=CGImageDestinationCreateWithURL(URL(fileURLWithPath:path) as CFURL,"public.png" as CFString,1,nil){CGImageDestinationAddImage(dest,image,nil);record(["event":"snapshot","ok":CGImageDestinationFinalize(dest)])}}}else{record(["event":"snapshot","ok":false,"reason":"not CVPixelBuffer"])}
        }
        if phase==7 || at-start>115 {record(["event":"complete","phase":phase,"clicksSent":clicks]);exit(phase==7 && clicks==24 ? 0:5)}
    }
}
