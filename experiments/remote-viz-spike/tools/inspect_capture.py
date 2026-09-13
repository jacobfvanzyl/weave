#!/usr/bin/env python3
"""Validate actual capture files; report reuse separately from resource reads."""
import collections
import hashlib
import json
import pathlib
import sys
root=pathlib.Path(sys.argv[1])
paths=list(root.glob('*-frame-*.json'))
paths.sort(key=lambda p:(p.name.split('-frame-')[0],int(p.stem.split('-frame-')[1])))
if not paths:raise SystemExit('NO_CHROMIUM_CAPTURES')
materials=collections.Counter();states_seen=collections.Counter();groups={};last_files={};payload=0;examined=0;proof=[];hashes={};frames=[]
for path in paths:
    d=json.loads(path.read_text())
    assert not d.get('synthetic'),f'{path}: synthetic input is not Chromium evidence'
    assert d['chromium_revision']=='507c6ee3e2f3b2ca0e660547e5b9ea4820c67f4c'
    assert d['all_referenced_resource_pixels_copied'],f'{path}: incomplete resources'
    resources={r['id']:r for r in d['resources']}
    for r in resources.values():
        assert not r.get('error'),r
        p=root/r['file'];assert p.parent==root
        b=p.read_bytes();assert len(b)==r['width']*r['height']*4
        digest=hashlib.sha256(b).hexdigest()
        assert hashes.setdefault(r['file'],digest)==digest
    group=path.name.split('-frame-')[0];previous=groups.get(group,{})
    uses=collections.defaultdict(list)
    for rp in d['render_passes']:
        sqs=rp['shared_quad_state_list']
        for i,q in enumerate(rp['quad_list']):
            materials[str(q['material'])]+=1
            ext=rp['quad_extensions'][i];rid=ext['resource_id_unsigned']
            state=sqs[q['shared_quad_state']['index']]
            states_seen['blend:'+state['blend_mode']]+=1
            if not ext['mask_filter_is_empty']:states_seen['nonemptyMask']+=1
            if state['sorting_context_id']:states_seen['nonzeroSortingContext']+=1
            if q.get('filters'):states_seen['foregroundFilters']+=1
            if q.get('backdrop_filters'):states_seen['backdropFilters']+=1
            if rid=='0':continue
            assert rid in resources,(path,rid)
            r=resources[rid];state=sqs[q['shared_quad_state']['index']]
            if q['visible_rect'][2]<=0 or q['visible_rect'][3]<=0:continue
            # Include geometry/UVs so a cropped or differently sampled use is not
            # confused with the same resource moving between frames.
            key=(str(rp['id']),rid,r['generation'],q['material'],tuple(q['rect']),tuple(q['visible_rect']),tuple(q.get('tex_coord_rect',[])))
            uses[key].append(state['quad_to_target_transform'])
    # Repeated uses of one texture are ambiguous without a stable quad identity.
    # Do not mistake a changed list order for that texture moving.
    current={key:matrices[0] for key,matrices in uses.items() if len(matrices)==1}
    for key,matrix in current.items():
        rid=key[1];r=resources[rid]
        if key in previous and previous[key]!=matrix and not r['uploaded']:
            proof.append({'frame':d['frame'],'file':path.name,'previousFile':last_files[group],'resourceId':rid,'generation':r['generation'],'resourceFile':r['file'],'resourceSha256':hashes[r['file']],'fromTransform':previous[key],'toTransform':matrix,'associatedRasterPayloadBytes':0})
    groups[group]=current
    last_files[group]=path.name
    payload+=d['resource_payload_bytes'];examined+=d['raster_bytes_examined']
    frames.append({'file':path.name,'frame':d['frame'],'passes':len(d['render_passes']),'resourcePayloadBytes':d['resource_payload_bytes'],'rasterBytesExamined':d['raster_bytes_examined'],'extractionUs':d['extraction_us'],'diagnosticJsonBytes':path.stat().st_size,'liveRasterBytes':sum(r['width']*r['height']*4 for r in resources.values())})
print(json.dumps({'actualChromiumCapture':True,'frames':len(paths),'materials':dict(materials),'stateCounts':dict(states_seen),'resourcePayloadBytes':payload,'rasterBytesExamined':examined,'uniqueResourceVersions':len(hashes),'diagnosticJsonBytes':sum(f['diagnosticJsonBytes'] for f in frames),'peakLiveRasterBytes':max(f['liveRasterBytes'] for f in frames),'sameResourceTransformChanges':len(proof),'transformReuseExamples':proof[:10],'perFrame':frames},indent=2))
