// WVE-79 offline Metal replay. Strict diagnostic subset, not product code.
import Foundation
import Metal
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers
import MetalPerformanceShaders

typealias Object = [String: Any]
struct Failure: Error, CustomStringConvertible { let description: String }
func require(_ ok: Bool, _ message: String) throws { if !ok { throw Failure(description: message) } }
func number(_ object: Object, _ key: String, _ fallback: Double = 0) -> Double {
    (object[key] as? NSNumber)?.doubleValue ?? fallback
}
func rect(_ value: Any?) throws -> CGRect {
    guard let a = value as? [Double], a.count == 4 else { throw Failure(description: "missing rectangle array") }
    let r = CGRect(x:a[0], y:a[1], width:a[2], height:a[3])
    try require([r.minX,r.minY,r.width,r.height].allSatisfy(\.isFinite), "nonfinite rectangle")
    return r
}
func passID(_ value: Any?) throws -> String {
    if let s = value as? String { return s.replacingOccurrences(of:"AggregatedRenderPass/",with:"") }
    if let d = value as? Object, let s = d["id_ref"] as? String { return s }
    throw Failure(description:"invalid pass ID")
}
struct Vertex { var position: SIMD2<Float>; var uv: SIMD2<Float>; var color: SIMD4<Float> }
struct Resource { var generation: Int; var texture: MTLTexture; var originTopLeft: Bool? }
struct DrawOptions { var sourceBounds: SIMD4<Float>; var masked: SIMD4<Float> }
struct Mask { var texture: MTLTexture; var origin: SIMD2<Float> }

final class Replay {
    let device: MTLDevice
    let queue: MTLCommandQueue
    let pipeline: MTLRenderPipelineState
    let replacePipeline: MTLRenderPipelineState
    let antialiasedPipeline: MTLRenderPipelineState
    let antialiasedReplacePipeline: MTLRenderPipelineState
    let linear: MTLSamplerState
    let nearest: MTLSamplerState
    let white: MTLTexture
    var resources: [String:Resource] = [:]
    var session: String?
    var uploadedBytes = 0
    var reusedResources = 0
    var masks: [String:Mask] = [:]
    var maskUploadedBytes = 0

    init() throws {
        guard let d = MTLCreateSystemDefaultDevice(), let q = d.makeCommandQueue() else {
            throw Failure(description:"Metal unavailable")
        }
        device=d; queue=q
        let source = """
        #include <metal_stdlib>
        using namespace metal;
        struct V { float2 position; float2 uv; float4 color; };
        struct O { float4 position [[position]]; float2 uv; float4 color; };
        vertex O vertexMain(const device V* v [[buffer(0)]], uint i [[vertex_id]]) {
            return {float4(v[i].position,0,1),v[i].uv,v[i].color};
        }
        struct DrawOptions { float4 sourceBounds; float4 masked; };
        fragment float4 fragmentMain(O in [[stage_in]], texture2d<float> image [[texture(0)]],
                                     texture2d<float> mask [[texture(1)]], sampler s [[sampler(0)]],
                                     constant DrawOptions& options [[buffer(0)]]) {
            float coverage = 1;
            if (options.masked.x > 0) {
                float2 point = in.position.xy-options.masked.yz;
                coverage = all(point >= 0) && all(point < float2(mask.get_width(),mask.get_height()))
                    ? mask.read(uint2(point)).a : 0;
            }
            float2 uv = clamp(in.uv, options.sourceBounds.xy, options.sourceBounds.zw);
            return image.sample(s,uv)*in.color*coverage;
        }
        """
        let library=try d.makeLibrary(source:source,options:nil)
        let descriptor=MTLRenderPipelineDescriptor()
        descriptor.vertexFunction=library.makeFunction(name:"vertexMain")
        descriptor.fragmentFunction=library.makeFunction(name:"fragmentMain")
        let color=descriptor.colorAttachments[0]!
        color.pixelFormat = .bgra8Unorm
        color.isBlendingEnabled=true
        color.sourceRGBBlendFactor = .one; color.sourceAlphaBlendFactor = .one
        color.destinationRGBBlendFactor = .oneMinusSourceAlpha; color.destinationAlphaBlendFactor = .oneMinusSourceAlpha
        pipeline=try d.makeRenderPipelineState(descriptor:descriptor)
        color.isBlendingEnabled=false
        replacePipeline=try d.makeRenderPipelineState(descriptor:descriptor)
        try require(d.supportsTextureSampleCount(4),"four-sample Metal antialiasing unavailable")
        descriptor.rasterSampleCount=4
        antialiasedReplacePipeline=try d.makeRenderPipelineState(descriptor:descriptor)
        color.isBlendingEnabled=true
        antialiasedPipeline=try d.makeRenderPipelineState(descriptor:descriptor)
        let sample=MTLSamplerDescriptor(); sample.sAddressMode = .clampToEdge; sample.tAddressMode = .clampToEdge
        sample.minFilter = .linear; sample.magFilter = .linear; linear=d.makeSamplerState(descriptor:sample)!
        sample.minFilter = .nearest; sample.magFilter = .nearest; nearest=d.makeSamplerState(descriptor:sample)!
        let td=MTLTextureDescriptor.texture2DDescriptor(pixelFormat:.bgra8Unorm,width:1,height:1,mipmapped:false)
        td.storageMode = .shared; td.usage = .shaderRead
        white=d.makeTexture(descriptor:td)!
        var pixel: UInt32=0xffffffff
        white.replace(region:MTLRegionMake2D(0,0,1,1),mipmapLevel:0,withBytes:&pixel,bytesPerRow:4)
    }

    func texture(width:Int,height:Int,target:Bool) throws -> MTLTexture {
        try require(width>0 && height>0 && width<=8192 && height<=8192 && width*height<=16_777_216,"texture size outside spike limits")
        let d=MTLTextureDescriptor.texture2DDescriptor(pixelFormat:.bgra8Unorm,width:width,height:height,mipmapped:false)
        d.storageMode = .shared; d.usage=target ? [.shaderRead,.renderTarget] : [.shaderRead]
        guard let t=device.makeTexture(descriptor:d) else { throw Failure(description:"Metal allocation failed") }
        return t
    }

    func needsAntialiasing(_ state:Object) -> Bool {
        guard let m=state["quad_to_target_transform"] as? [Double],m.count==16 else { return false }
        return m[0] != 1 || m[5] != 1 || m[1] != 0 || m[4] != 0 || m[3].rounded() != m[3] || m[7].rounded() != m[7]
    }

    // First filter gate: one isotropic, transparent-edge blur, using Chromium's
    // captured output bounds and Apple's maintained GPU kernel.
    func blur(source:MTLTexture, quad:Object, extra:Object, command:MTLCommandBuffer) throws -> (MTLTexture,CGRect) {
        guard let filters=quad["filters"] as? [Object],filters.count==1,
              number(filters[0],"type",-1)==8,
              quad["filters_scale"] as? [Double] == [1,1],
              quad["filters_origin"] as? [Double] == [0,0],
              extra["blur_uses_decal"] as? Bool == true else {
            throw Failure(description:"unsupported filter: one unit-scale decal blur required")
        }
        let sigma=number(filters[0],"amount",-1)
        try require(sigma.isFinite && sigma>0 && sigma<=64,"unsupported blur sigma")
        let input=try rect(quad["rect"]),bounds=try rect(extra["filter_output_rect"])
        try require(input.width==Double(source.width) && input.height==Double(source.height),"unsupported blur backing size")
        try require(bounds.contains(input) && [bounds.minX,bounds.minY,bounds.width,bounds.height].allSatisfy({$0.rounded()==$0}),"invalid blur output bounds")
        let width=Int(bounds.width),height=Int(bounds.height)
        try require(width>0 && height>0 && width<=8192 && height<=8192 && width*height<=16_777_216,"blur output exceeds limits")
        let descriptor=MTLTextureDescriptor.texture2DDescriptor(pixelFormat:.bgra8Unorm,width:width,height:height,mipmapped:false)
        descriptor.storageMode = .private; descriptor.usage=[.shaderRead,.shaderWrite]
        guard let result=device.makeTexture(descriptor:descriptor) else { throw Failure(description:"blur allocation failed") }
        let kernel=MPSImageGaussianBlur(device:device,sigma:Float(sigma))
        kernel.edgeMode = .zero
        kernel.offset=MPSOffset(x:Int(bounds.minX-input.minX),y:Int(bounds.minY-input.minY),z:0)
        kernel.encode(commandBuffer:command,sourceTexture:source,destinationTexture:result)
        return (result,bounds)
    }

    // Use the native path rasterizer for clip coverage; retain Metal composition.
    // Initial mask support is a uniform circular radius, not arbitrary gradients.
    func mask(_ extra:Object, output:CGRect) throws -> Mask? {
        if extra["mask_filter_is_empty"] as? Bool == true { return nil }
        guard let mask=extra["mask"] as? Object,
              mask["has_gradient"] as? Bool == false,
              let radii=mask["radii"] as? [Double], radii.count==8,
              radii.allSatisfy({ $0.isFinite && $0>=0 && $0==radii[0] }) else {
            throw Failure(description:"unsupported mask: structured uniform radii without gradient required")
        }
        let bounds=try rect(mask["bounds"]), radius=radii[0]
        try require(bounds.width>0 && bounds.height>0 && radius<=min(bounds.width,bounds.height)/2,"invalid rounded mask")
        let key="\(output):\(bounds):\(radius)"
        if let cached=masks[key] { return cached }
        let extent=bounds.intersection(output).integral
        try require(!extent.isNull && !extent.isEmpty,"mask outside render target")
        let width=Int(extent.width),height=Int(extent.height)
        let image=try texture(width:width,height:height,target:false)
        var pixels=[UInt8](repeating:0,count:width*height*4)
        try pixels.withUnsafeMutableBytes { bytes in
            guard let context=CGContext(data:bytes.baseAddress,width:width,height:height,bitsPerComponent:8,
                bytesPerRow:width*4,space:CGColorSpaceCreateDeviceRGB(),
                bitmapInfo:CGBitmapInfo.byteOrder32Little.rawValue|CGImageAlphaInfo.premultipliedFirst.rawValue) else {
                throw Failure(description:"native mask context unavailable")
            }
            context.setAllowsAntialiasing(true); context.setShouldAntialias(true)
            context.translateBy(x:0,y:CGFloat(height)); context.scaleBy(x:1,y:-1)
            context.setFillColor(red:1,green:1,blue:1,alpha:1)
            let local=bounds.offsetBy(dx:-extent.minX,dy:-extent.minY)
            context.addPath(CGPath(roundedRect:local,cornerWidth:radius,cornerHeight:radius,transform:nil))
            context.fillPath()
            image.replace(region:MTLRegionMake2D(0,0,width,height),mipmapLevel:0,withBytes:bytes.baseAddress!,bytesPerRow:width*4)
        }
        // Bounded diagnostic cache; a production renderer needs resource budgets.
        if masks.count>=16 { masks.removeAll() }
        let result=Mask(texture:image,origin:SIMD2(Float(extent.minX-output.minX),Float(extent.minY-output.minY)))
        maskUploadedBytes+=width*height*4
        masks[key]=result; return result
    }

    func render(file:URL, output:URL) throws -> Object {
        let started=Date()
        let data=try Data(contentsOf:file)
        guard let frame=try JSONSerialization.jsonObject(with:data) as? Object,
              let passes=frame["render_passes"] as? [Object], !passes.isEmpty,
              let incoming=frame["resources"] as? [Object] else { throw Failure(description:"invalid capture") }
        try require(number(frame,"capture_schema")==1,"unsupported capture schema")
        try require(frame["all_referenced_resource_pixels_copied"] as? Bool == true,"incomplete resource capture")
        guard let incomingSession=frame["capture_session"] as? String else { throw Failure(description:"capture session missing") }
        if session != incomingSession { resources.removeAll(); masks.removeAll(); session=incomingSession }
        uploadedBytes=0; reusedResources=0; maskUploadedBytes=0
        for id in frame["deleted_resources"] as? [String] ?? [] { resources.removeValue(forKey:id) }
        for r in incoming {
            guard let id=r["id"] as? String, let name=r["file"] as? String else { throw Failure(description:"resource identity missing") }
            try require(!name.contains("/") && !name.contains(".."),"invalid resource filename")
            let gen=Int(number(r,"generation")), w=Int(number(r,"width")), h=Int(number(r,"height"))
            if let cached=resources[id], cached.generation==gen {
                try require(cached.texture.width==w && cached.texture.height==h,"generation reused with new shape")
                try require(cached.originTopLeft==r["origin_top_left"] as? Bool,"resource origin changed within a generation")
                reusedResources+=1; continue
            }
            let bytes=try Data(contentsOf:file.deletingLastPathComponent().appendingPathComponent(name))
            try require(number(r,"row_bytes")==Double(w*4) && bytes.count==w*h*4,"resource byte count mismatch")
            let t=try texture(width:w,height:h,target:false)
            bytes.withUnsafeBytes { p in t.replace(region:MTLRegionMake2D(0,0,w,h),mipmapLevel:0,withBytes:p.baseAddress!,bytesPerRow:w*4) }
            resources[id]=Resource(generation:gen,texture:t,originTopLeft:r["origin_top_left"] as? Bool); uploadedBytes+=bytes.count
        }
        let resourceLoadMs=Date().timeIntervalSince(started)*1000
        let encodeStarted=Date()
        guard let command=queue.makeCommandBuffer() else { throw Failure(description:"command buffer unavailable") }
        var targets:[String:MTLTexture]=[:]
        var root:MTLTexture?
        var quadCount=0
        var filteredPassQuads=0
        var antialiasedPasses=0
        for pass in passes {
            let outputRect=try rect(pass["output_rect"])
            try require(outputRect.width.rounded()==outputRect.width && outputRect.height.rounded()==outputRect.height,"fractional render target size")
            let target=try texture(width:Int(outputRect.width),height:Int(outputRect.height),target:true)
            let id=try passID(pass["id"])
            try require(targets[id]==nil,"duplicate pass ID")
            guard let quads=pass["quad_list"] as? [Object], let states=pass["shared_quad_state_list"] as? [Object],
                  let extensions=pass["quad_extensions"] as? [Object], extensions.count==quads.count else {
                throw Failure(description:"missing quad state or diagnostic supplements")
            }
            try require(pass["generate_mipmap"] as? Bool != true,"unsupported pass mipmaps")
            var filtered:[Int:(MTLTexture,CGRect)]=[:]
            for (index,quad) in quads.enumerated() where number(quad,"material")==4 {
                try require(quad["filters"] is [Object],"missing foreground filter metadata")
                try require((quad["backdrop_filters"] as? [Any])?.isEmpty==true,"unsupported backdrop filters")
                try require(extensions[index]["resource_id_unsigned"] as? String == "0","unsupported pass mask texture")
                if (quad["filters"] as? [Any])?.isEmpty==false {
                    let reference=try passID(quad["render_pass_id"])
                    guard let source=targets[reference] else { throw Failure(description:"missing filtered pass dependency") }
                    filtered[index]=try blur(source:source,quad:quad,extra:extensions[index],command:command)
                    filteredPassQuads+=1
                }
            }
            let antialiased=states.contains(where:needsAntialiasing)
            let blendState=antialiased ? antialiasedPipeline:pipeline
            let replaceState=antialiased ? antialiasedReplacePipeline:replacePipeline
            let descriptor=MTLRenderPassDescriptor()
            descriptor.colorAttachments[0].texture=target
            descriptor.colorAttachments[0].loadAction = .clear
            descriptor.colorAttachments[0].storeAction = .store
            descriptor.colorAttachments[0].clearColor=MTLClearColorMake(0,0,0,pass["has_transparent_background"] as? Bool == false ? 1 : 0)
            if antialiased {
                let msaa=MTLTextureDescriptor.texture2DDescriptor(pixelFormat:.bgra8Unorm,width:target.width,height:target.height,mipmapped:false)
                msaa.textureType = .type2DMultisample; msaa.sampleCount=4
                msaa.storageMode = .private; msaa.usage = .renderTarget
                guard let samples=device.makeTexture(descriptor:msaa) else { throw Failure(description:"antialiasing allocation failed") }
                descriptor.colorAttachments[0].texture=samples
                descriptor.colorAttachments[0].resolveTexture=target
                descriptor.colorAttachments[0].storeAction = .multisampleResolve
                antialiasedPasses+=1
            }
            guard let encoder=command.makeRenderCommandEncoder(descriptor:descriptor) else { throw Failure(description:"render encoder unavailable") }
            encoder.setRenderPipelineState(blendState)
            var currentQuad = -1
            do {
                for index in quads.indices.reversed() {
                    currentQuad=index
                    let quad=quads[index], extra=extensions[index]
                    let material=Int(number(quad,"material"))
                    let stateRef=quad["shared_quad_state"] as? Object ?? [:]
                    let si=Int(number(stateRef,"index",-1))
                    try require(states.indices.contains(si),"invalid shared-state index")
                    let state=states[si]
                    try require(number(state,"sorting_context_id")==0,"unsupported 3D sorting context")
                    try require(state["blend_mode"] as? String == "SrcOver","unsupported blend mode")
                    let maskImage=try mask(extra,output:outputRect)
                    guard let matrix=state["quad_to_target_transform"] as? [Double],matrix.count==16,matrix.allSatisfy(\.isFinite) else {
                        throw Failure(description:"invalid transform")
                    }
                    try require([2,6,8,9,11,12,13,14].allSatisfy({matrix[$0]==0}) && matrix[10]==1 && matrix[15]==1,"unsupported perspective or 3D transform")
                    try require(abs(matrix[0]*matrix[5]-matrix[1]*matrix[4])>0.000001 && matrix.allSatisfy({abs($0)<=1_000_000}),"singular or excessive affine transform")
                    var qr=try rect(quad["rect"]), visible=try rect(quad["visible_rect"])
                    if let (_,bounds)=filtered[index] { qr=bounds; visible=bounds }
                    if visible.isEmpty { continue }
                    try require(qr.width>0 && qr.height>0 && qr.contains(visible),"invalid visible rect")
                    var clip=outputRect
                    if state["clip_rect"] != nil { clip=clip.intersection(try rect(state["clip_rect"])) }
                    if clip.isNull || clip.isEmpty { continue }
                    let x=max(0,Int(ceil(clip.minX-outputRect.minX))), y=max(0,Int(ceil(clip.minY-outputRect.minY)))
                    let x2=min(target.width,Int(floor(clip.maxX-outputRect.minX))), y2=min(target.height,Int(floor(clip.maxY-outputRect.minY)))
                    if x2<=x || y2<=y { continue }
                    encoder.setScissorRect(MTLScissorRect(x:x,y:y,width:x2-x,height:y2-y))
                    let opacity=Float(number(state,"opacity",1))
                    try require(opacity>=0 && opacity<=1,"invalid opacity")
                    guard let needsBlending=quad["needs_blending"] as? Bool else { throw Failure(description:"missing blending flag") }
                    let blends=needsBlending || opacity<1
                    var image=white
                    var uv=CGRect(x:0,y:0,width:1,height:1)
                    var tint=SIMD4<Float>(repeating:opacity)
                    switch material {
                    case 5:
                        guard let c=extra["solid_color_rgba"] as? [Double],c.count==4 else { throw Failure(description:"missing solid RGBA") }
                        let alpha=Float(c[3])*opacity
                        tint=SIMD4(Float(c[0])*alpha,Float(c[1])*alpha,Float(c[2])*alpha,alpha)
                    case 10:
                        guard let rid=extra["resource_id_unsigned"] as? String, let resource=resources[rid] else { throw Failure(description:"missing tile resource") }
                        image=resource.texture
                        let t=try rect(quad["tex_coord_rect"])
                        // The fragment shader constrains filtering to this source
                        // subrectangle, including fractional compositor offsets.
                        try require(t.width>=1 && t.height>=1 && t.minX>=0 && t.minY>=0 && t.maxX<=Double(image.width) && t.maxY<=Double(image.height),"tile source outside resource")
                        uv=CGRect(x:t.minX/Double(image.width),y:t.minY/Double(image.height),width:t.width/Double(image.width),height:t.height/Double(image.height))
                    case 9:
                        guard let rid=extra["resource_id_unsigned"] as? String,let resource=resources[rid],
                              resource.originTopLeft==true,
                              let background=extra["texture_background_rgba"] as? [Double],background==[0,0,0,0],
                              quad["force_rgbx"] as? Bool == false,
                              quad["secure_output_only"] as? Bool == false,
                              quad["is_video_frame"] as? Bool == false,
                              number(quad,"protected_video_type",-1)==0,
                              quad["rounded_display_masks_info"] as? String == "0,0,is_horizontally_positioned=1",
                              let normalized=quad["is_normalized_coords"] as? Bool else {
                            throw Failure(description:"unsupported texture flags, background, resource origin or missing metadata")
                        }
                        image=resource.texture
                        var source=try rect(quad["tex_coord_rect"])
                        if normalized { source=CGRect(x:source.minX*Double(image.width),y:source.minY*Double(image.height),width:source.width*Double(image.width),height:source.height*Double(image.height)) }
                        try require(source.width>=1 && source.height>=1 && source.minX>=0 && source.minY>=0 && source.maxX<=Double(image.width) && source.maxY<=Double(image.height),"texture source outside resource")
                        try require([source.minX,source.minY,source.width,source.height].allSatisfy({$0.rounded()==$0}),"unsupported fractional texture source")
                        uv=CGRect(x:source.minX/Double(image.width),y:source.minY/Double(image.height),width:source.width/Double(image.width),height:source.height/Double(image.height))
                    case 4:
                        try require(extra["resource_id_unsigned"] as? String == "0","unsupported pass mask texture")
                        let reference=try passID(quad["render_pass_id"])
                        guard let previous=targets[reference] else { throw Failure(description:"pass reference is not earlier in graph") }
                        image=previous
                        uv=CGRect(x:0,y:0,width:qr.width/Double(image.width),height:qr.height/Double(image.height))
                        if let (blurred,_)=filtered[index] { image=blurred; uv=CGRect(x:0,y:0,width:1,height:1) }
                    default:
                        throw Failure(description:"unsupported quad material \(material) in pass \(id), quad \(index)")
                    }
                    let fractions=CGRect(x:(visible.minX-qr.minX)/qr.width,y:(visible.minY-qr.minY)/qr.height,width:visible.width/qr.width,height:visible.height/qr.height)
                    let sampled=CGRect(x:uv.minX+fractions.minX*uv.width,y:uv.minY+fractions.minY*uv.height,width:fractions.width*uv.width,height:fractions.height*uv.height)
                    // Src replacement with fractional coverage is equivalent to
                    // SrcOver only for opaque source; reject other masked cases.
                    let opaqueSource = material==5 && tint.w==1 ||
                        (material==9 || material==10) && state["are_contents_opaque"] as? Bool == true && opacity==1
                    try require(maskImage==nil || blends || opaqueSource,"unsupported masked Src replacement")
                    encoder.setRenderPipelineState(blends || maskImage != nil ? blendState : replaceState)
                    let halfX=0.5/Double(image.width),halfY=0.5/Double(image.height)
                    try require(material==5 || sampled.width>=2*halfX && sampled.height>=2*halfY,"sample rectangle smaller than one texel")
                    var options=DrawOptions(sourceBounds:SIMD4(Float(sampled.minX+halfX),Float(sampled.minY+halfY),Float(sampled.maxX-halfX),Float(sampled.maxY-halfY)),masked:SIMD4(maskImage==nil ? 0:1,0,0,0))
                    if let maskImage { options.masked=SIMD4(1,maskImage.origin.x,maskImage.origin.y,0) }
                    if material==5 { options.sourceBounds=SIMD4(repeating:0.5) }
                    func vertex(_ fx:Double,_ fy:Double) -> Vertex {
                        let x=visible.minX+fx*visible.width,y=visible.minY+fy*visible.height
                        let px=matrix[0]*x+matrix[1]*y+matrix[3]-outputRect.minX
                        let py=matrix[4]*x+matrix[5]*y+matrix[7]-outputRect.minY
                        return Vertex(position:SIMD2(Float(px/Double(target.width)*2-1),Float(1-py/Double(target.height)*2)),uv:SIMD2(Float(sampled.minX+fx*sampled.width),Float(sampled.minY+fy*sampled.height)),color:tint)
                    }
                    let vertices=[vertex(0,0),vertex(1,0),vertex(0,1),vertex(1,0),vertex(1,1),vertex(0,1)]
                    vertices.withUnsafeBytes { bytes in encoder.setVertexBytes(bytes.baseAddress!,length:bytes.count,index:0) }
                    encoder.setFragmentTexture(image,index:0)
                    encoder.setFragmentTexture(maskImage?.texture ?? white,index:1)
                    encoder.setFragmentBytes(&options,length:MemoryLayout<DrawOptions>.stride,index:0)
                    encoder.setFragmentSamplerState(quad["nearest_neighbor"] as? Bool == true ? nearest : linear,index:0)
                    encoder.drawPrimitives(type:.triangle,vertexStart:0,vertexCount:6)
                    quadCount+=1
                }
            } catch {
                encoder.endEncoding()
                throw Failure(description:"frame \(Int(number(frame,"frame"))), pass \(id), quad \(currentQuad): \(error)")
            }
            encoder.endEncoding(); targets[id]=target; root=target
        }
        let metalEncodeMs=Date().timeIntervalSince(encodeStarted)*1000
        let waitStarted=Date()
        command.commit(); command.waitUntilCompleted()
        let submitAndWaitMs=Date().timeIntervalSince(waitStarted)*1000
        if let error=command.error { throw error }
        guard let root else { throw Failure(description:"missing root pass") }
        var pixels=[UInt8](repeating:0,count:root.width*root.height*4)
        root.getBytes(&pixels,bytesPerRow:root.width*4,from:MTLRegionMake2D(0,0,root.width,root.height),mipmapLevel:0)
        let provider=CGDataProvider(data:Data(pixels) as CFData)!
        let bitmap=CGBitmapInfo.byteOrder32Little.union(CGBitmapInfo(rawValue:CGImageAlphaInfo.premultipliedFirst.rawValue))
        guard let cg=CGImage(width:root.width,height:root.height,bitsPerComponent:8,bitsPerPixel:32,bytesPerRow:root.width*4,space:CGColorSpace(name:CGColorSpace.sRGB)!,bitmapInfo:bitmap,provider:provider,decode:nil,shouldInterpolate:false,intent:.defaultIntent),
              let destination=CGImageDestinationCreateWithURL(output as CFURL,UTType.png.identifier as CFString,1,nil) else { throw Failure(description:"PNG destination unavailable") }
        CGImageDestinationAddImage(destination,cg,nil)
        try require(CGImageDestinationFinalize(destination),"PNG write failed")
        return ["frame":number(frame,"frame"),"passes":passes.count,"quads":quadCount,"filteredPassQuads":filteredPassQuads,"antialiasedPasses":antialiasedPasses,"uploadedBytes":uploadedBytes,"maskUploadedBytes":maskUploadedBytes,"cachedMaskBytes":masks.values.reduce(0){$0+$1.texture.width*$1.texture.height*4},"reusedResources":reusedResources,"cachedResources":resources.count,"cachedRasterBytes":resources.values.reduce(0){$0+$1.texture.width*$1.texture.height*4},"diagnosticJsonBytes":data.count,"resourceLoadMs":resourceLoadMs,"metalEncodeMs":metalEncodeMs,"submitAndWaitMs":submitAndWaitMs,"gpuExecutionMs":max(0,command.gpuEndTime-command.gpuStartTime)*1000,"elapsedMs":Date().timeIntervalSince(started)*1000,"gpu":device.name,"output":output.path]
    }
}

do {
    try require(CommandLine.arguments.count>=3,"Usage: viz-replay OUTPUT_DIRECTORY FRAME.json [FRAME.json ...]")
    let out=URL(fileURLWithPath:CommandLine.arguments[1],isDirectory:true)
    try FileManager.default.createDirectory(at:out,withIntermediateDirectories:true)
    let replay=try Replay()
    for path in CommandLine.arguments.dropFirst(2) {
        let file=URL(fileURLWithPath:path)
        let result=try replay.render(file:file,output:out.appendingPathComponent(file.deletingPathExtension().lastPathComponent+".png"))
        print(String(data:try JSONSerialization.data(withJSONObject:result,options:.sortedKeys),encoding:.utf8)!)
    }
} catch { fputs("REPLAY_REJECTED: \(error)\n",stderr); exit(1) }
