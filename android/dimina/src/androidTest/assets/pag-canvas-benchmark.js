(async()=>{
    const report={samples:[],pixels:[]}, encode=DiminaServiceBridge.encodeCanvasArrayBuffer;
    let file, view;
    try {
        const PAG=await modRequire('pag-benchmark').PAGInit({locateFile:name=>'/pages/libpag/assets/'+name});
        const input=wx.getFileSystemManager().readFileSync('/pages/libpag/assets/video.pag');
        report.input={type:Object.prototype.toString.call(input),bytes:input?.byteLength,magic:Array.from(new Uint8Array(input).subarray(0,4))};
        file=await PAG.PAGFile.load(input);
        report.source={width:file.width(),height:file.height(),duration:file.duration(),fps:file.frameRate()};
        const canvas=wx.createCanvas();canvas.width=file.width();canvas.height=file.height();
        for(const mode of ['base64','native']){
            DiminaServiceBridge.encodeCanvasArrayBuffer=mode==='base64'?undefined:encode;
            view=await PAG.PAGView.init(file,canvas,{firstFrame:false});view.setRepeatCount(0);
            const hashes=[];
            for(const progress of [0,0.5,0.9]){
                view.setProgress(progress);await view.flush();
                if(canvas.getContext('webgl').getError()!==0)throw Error('PAG flush GL error');
                const pixels=__pagPresentedPixels(null);
                if(pixels.error)throw Error(pixels.error);
                hashes.push(pixels);
            }
            report.pixels.push(hashes);
            if(!hashes.some(value=>value.alpha>0))throw Error('PAG checkpoints are all transparent');
            view.setProgress(0);
            let frames=0,measuring=false,maxFlush=0;
            const flush=view.flush.bind(view);
            view.flush=async function(){const start=Date.now(),result=await flush();if(measuring&&result){frames++;maxFlush=Math.max(maxFlush,Date.now()-start)}return result};
            await view.play();await new Promise(resolve=>setTimeout(resolve,2000));
            measuring=true;const start=Date.now();await new Promise(resolve=>setTimeout(resolve,10000));
            const elapsedMs=Date.now()-start;measuring=false;await view.pause();
            report.samples.push({mode,frames,elapsedMs,fps:frames*1000/elapsedMs,maxFlush,debug:view.getDebugData()});
            await view.destroy();view=null;
        }
    }catch(error){report.error=String(error)+'\n'+String(error?.stack||'')}
    finally{DiminaServiceBridge.encodeCanvasArrayBuffer=encode;try{if(view)await view.destroy();if(file)file.destroy()}catch(e){}__pagCanvasReport(JSON.stringify(report))}
})();
