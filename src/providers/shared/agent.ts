/**
 * src/providers/shared/agent.ts — THE ON-MACHINE TELEMETRY AGENT (Python 3)
 *
 * Installed by the setup script as cloudgaming-agent.service. Every 15 s it
 * prints one line to the serial console:
 *     CGT {"t":epoch,"c":cpu%,"cm":peak cpu%,"l":load,"m":[usedGiB,totalGiB],
 *          "sw":swapGiB,"d":[usedGiB,totalGiB],"dr"/"dw":disk MB/s,
 *          "ni"/"no":network Mbit/s,"g":{GPU},"ct":°C|null,"up":s,
 *          "x":Xid count,"xl":last Xid,"o":OOM kills,"f":[failed units],
 *          "k":[containers],"p":[[process,cpu%]...]}
 *   g: u gpu%, um peak gpu%, mu memory-controller%, vu/vt VRAM MiB, tp °C,
 *      pw/pl power W, cl/cx clock MHz, es/ef/el encoder sessions/fps/latency
 *      µs, ps P-state, eu encoder% and th throttle reasons where supported.
 * Every 5 min: grows the root filesystem into new disk space and prints
 * CLOUDGAMING_DISK; every 10 min: re-prints the current setup stage so it
 * never scrolls out of the console buffer. No ports are opened: the app
 * reads the console through the cloud's API (parseTelemetry).
 *
 * Shipped inside the setup script (Google, Azure, Oracle) or downloaded at
 * boot from GET /api/agent/cgtel.py and checked against AGENT_SHA256 (AWS,
 * whose 16 KB user-data limit can't hold it). Must not contain backticks or
 * "${" (it's spliced into the bash template), nor whole-line "#" comments
 * (compactScript would strip them).
 */
import crypto from 'crypto';

export const AGENT_SOURCE = String.raw`import json,os,re,subprocess as sp,time
def rd(p):
 try:return open(p).read()
 except Exception:return ''
def sh(c):
 try:return sp.run(c,shell=True,capture_output=True,text=True,timeout=10).stdout.strip()
 except Exception:return ''
def n(v):
 try:return round(float(v),1)
 except Exception:return None
def out(s):
 try:open('/dev/ttyS0','w').write(s+'\n')
 except Exception:pass
G='utilization.gpu,utilization.memory,memory.used,memory.total,temperature.gpu,power.draw,power.limit,clocks.gr,clocks.max.gr,encoder.stats.sessionCount,encoder.stats.averageFps,encoder.stats.averageLatency,pstate'
K='u mu vu vt tp pw pl cl cx es ef el ps'.split()
for f,k in(('utilization.encoder','eu'),('clocks_event_reasons.active','th')):
 if'valid'not in(sh('nvidia-smi --query-gpu='+f+' --format=csv,noheader 2>&1')or'valid'):G+=','+f;K.append(k)
def gpu():
 v=sh('nvidia-smi --query-gpu='+G+' --format=csv,noheader,nounits').split('\n')[0].split(',')
 return{k:(x.strip()if k in('ps','th')else n(x))for k,x in zip(K,v)}if len(v)==len(K)else None
def cpu():
 v=[int(x)for x in rd('/proc/stat').split('\n')[0].split()[1:8]];return sum(v),v[3]+v[4]
def net():
 r=t=0
 for l in rd('/proc/net/dev').split('\n')[2:]:
  if':'in l:
   a,d=l.split(':',1);a=a.strip();d=d.split()
   if a!='lo'and not a.startswith(('docker','veth','br-')):r+=int(d[0]);t+=int(d[8])
 return r,t
def dio():
 r=w=0
 for l in rd('/proc/diskstats').split('\n'):
  f=l.split()
  if len(f)>9 and re.match(r'(sd|vd|xvd)[a-z]+$|nvme\d+n\d+$',f[2]):r+=int(f[5]);w+=int(f[9])
 return r*512,w*512
def grow():
 for p in sh('ls /sys/class/block/*/device/rescan 2>/dev/null').split():
  try:open(p,'w').write('1')
  except Exception:pass
 s=sh('findmnt -no SOURCE /');k=sh('lsblk -no PKNAME '+s+' | head -1');q=rd('/sys/class/block/'+os.path.basename(s)+'/partition').strip()
 if k and q and sp.run('growpart /dev/'+k+' '+q,shell=True,capture_output=True).returncode==0:sh('resize2fs '+s+' || xfs_growfs /')
c0,n0,d0,t0,i,gm,cm=cpu(),net(),dio(),time.time(),0,0,0
while 1:
 time.sleep(3);i+=1;g=gpu();c=cpu()
 if g and g.get('u')is not None:gm=max(gm,g['u'])
 cm=max(cm,100*(1-(c[1]-c0[1])/max(1,c[0]-c0[0])))if i%5 else cm
 if i%5:continue
 if i%100==5:
  grow();s=os.statvfs('/');out('CLOUDGAMING_DISK %d %d %d'%((s.f_blocks-s.f_bfree)*s.f_frsize>>20,s.f_blocks*s.f_frsize>>20,time.time()))
 if i%200==5:
  x=re.findall(r'CLOUDGAMING_STAGE[^\n]*',rd('/var/log/cloudgaming-setup.log')[-30000:])
  if x:out(x[-1])
 nt,d,t=net(),dio(),time.time();dt=t-t0
 m={l.split(':')[0]:int(l.split()[1])for l in rd('/proc/meminfo').split('\n')if l}
 j=sh('journalctl -k -b --no-pager -q');s=os.statvfs('/');tz=[int(x)/1000 for x in(rd(p).strip()for p in sh('ls /sys/class/thermal/thermal_zone*/temp 2>/dev/null').split())if x]
 if g:g['um']=gm
 out('CGT '+json.dumps({'t':int(t),'c':n(100*(1-(c[1]-c0[1])/max(1,c[0]-c0[0]))),'cm':n(cm),'l':n(rd('/proc/loadavg').split()[0]),
  'm':[n((m['MemTotal']-m['MemAvailable'])/1048576),n(m['MemTotal']/1048576)],'sw':n((m.get('SwapTotal',0)-m.get('SwapFree',0))/1048576),
  'd':[n((s.f_blocks-s.f_bfree)*s.f_frsize/2**30),n(s.f_blocks*s.f_frsize/2**30)],'dr':n((d[0]-d0[0])/dt/2**20),'dw':n((d[1]-d0[1])/dt/2**20),
  'ni':n((nt[0]-n0[0])*8/dt/1e6),'no':n((nt[1]-n0[1])*8/dt/1e6),'g':g,'ct':max(tz)if tz else None,'up':n(rd('/proc/uptime').split()[0]),
  'x':len(re.findall('NVRM: Xid',j)),'xl':(re.findall(r'NVRM: Xid[^\n]{0,160}',j)or[None])[-1],'o':len(re.findall('Out of memory: Killed',j)),
  'f':sh("systemctl --failed --no-legend --plain | awk '{print $1}'").split(),'k':[x for x in sh("docker ps -a --format '{{.Names}}: {{.Status}}'").split('\n')if x],
  'p':[l.split(None,1)[::-1]for l in sh("top -bn2 -d0.5 -o %CPU -w 200 | awk '/^top -/{f++} f==2 && $1~/^[0-9]+$/{print $9, $12}' | head -3").split('\n')if l.strip()]},separators=(',',':')))
 c0,n0,d0,t0,gm,cm=c,nt,d,t,0,0
`;

/** sha256 of the file as written on the machine (source + trailing newline). */
export const AGENT_SHA256 = crypto.createHash('sha256').update(AGENT_SOURCE).digest('hex');
