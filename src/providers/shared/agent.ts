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
 *   sn: every minute, Sunshine's last error lines ("e"), how many times it
 *      exited recently ("x") and its last log lines ("l": where a crash hit).
 * GPU (nvidia-smi) is only queried every 15 s, and not at all while the
 * streaming container is starting/unhealthy (stays clear of Sunshine's
 * encoder setup).
 *   gf: the game's own frame rate from MangoHud's log (null when no game
 *      is running): n game, f average fps, lo lowest 1-s fps, ft worst
 *      frame time (ms) over the last 15 s, p1 the 1st-percentile fps and sc
 *      the stutter count (1-s samples under 60% of the median) over 60 s.
 *   cc [busiest core %, cores], cs CPU steal %, cw I/O wait %, pr pressure
 *      stall % [cpu, memory, io], dl [read ms, write ms, queue], ne [NIC
 *      errors, drops, UDP errors] this interval, tx GB sent since boot,
 *      rt streaming client's ping {r avg ms, j jitter, l loss %; o 1 = no
 *      ping reply}, gp [[program, VRAM MiB, GPU %]...], ss stream settings
 *      {b Mbit/s, e encoder, d bit depth, r WxH, f fps}, sp spot notice
 *      (preempted | terminate | preempt | maintenance) from the cloud's
 *      metadata service. g also has lg/lx/lw/lm PCIe link gen/max/width/max.
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
for f,k in(('utilization.encoder','eu'),('clocks_event_reasons.active','th'),('pcie.link.gen.current','lg'),('pcie.link.gen.max','lx'),('pcie.link.width.current','lw'),('pcie.link.width.max','lm'),('fan.speed','fs')):
 if'valid'not in(sh('nvidia-smi --query-gpu='+f+' --format=csv,noheader 2>&1')or'valid'):G+=','+f;K.append(k)
def gpu():
 v=sh('nvidia-smi --query-gpu='+G+' --format=csv,noheader,nounits').split('\n')[0].split(',')
 return{k:(x.strip()if k in('ps','th')else n(x))for k,x in zip(K,v)}if len(v)==len(K)else None
def cpu():
 L=[[int(x)for x in l.split()[1:9]]for l in rd('/proc/stat').split('\n')if l.startswith('cpu')]
 return sum(L[0][:7]),L[0][3]+L[0][4],L[0][7],L[0][4],[(sum(v[:7]),v[3]+v[4])for v in L[1:]]
def net():
 r=t=e=x=0
 for l in rd('/proc/net/dev').split('\n')[2:]:
  if':'in l:
   a,d=l.split(':',1);a=a.strip();d=d.split()
   if a!='lo'and not a.startswith(('docker','veth','br-')):r+=int(d[0]);t+=int(d[8]);e+=int(d[2])+int(d[10]);x+=int(d[3])+int(d[11])
 return r,t,e,x
def udp():
 L=[l.split()for l in rd('/proc/net/snmp').split('\n')if l.startswith('Udp:')]
 try:h,v=L[0],L[1];return sum(int(v[h.index(k)])for k in('InErrors','RcvbufErrors','SndbufErrors'))
 except Exception:return 0
def dio():
 r=w=a=b=c=d=q=0
 for l in rd('/proc/diskstats').split('\n'):
  f=l.split()
  if len(f)>11 and re.match(r'(sd|vd|xvd)[a-z]+$|nvme\d+n\d+$',f[2]):r+=int(f[5]);w+=int(f[9]);a+=int(f[3]);b+=int(f[6]);c+=int(f[7]);d+=int(f[10]);q+=int(f[11])
 return r*512,w*512,a,b,c,d,q
def fps():
 L='/var/lib/cloudgaming/sunshine/fps/'
 try:fs=sorted((os.path.getmtime(L+f),f)for f in os.listdir(L)if f.endswith('.csv'))
 except Exception:return None
 for t,f in fs[:-1]:
  if time.time()-t>172800:
   try:os.remove(L+f)
   except Exception:pass
 if not fs or time.time()-fs[-1][0]>20:return None
 b=open(L+fs[-1][1],'rb');b.seek(0,2);b.seek(max(0,b.tell()-12000))
 v=[(float(x[0]),float(x[1]))for x in(l.split(',')for l in b.read().decode('utf8','ignore').split('\n')[1:])if len(x)>2 and re.match(r'[0-9.]+$',x[0])and re.match(r'[0-9.]+$',x[1])][-60:]
 if not v:return None
 w=v[-15:];f=[a for a,_ in w];z=sorted(a for a,_ in v);md=z[len(z)//2]
 return{'n':re.sub(r'_[0-9]{4}-[0-9-]{5}_[0-9-]{8}\.csv$','',fs[-1][1]),'f':n(sum(f)/len(f)),'lo':n(min(f)),'ft':n(max(a for _,a in w)),'p1':n(z[int(len(z)*0.01)]),'sc':sum(1 for a in z if a<md*0.6),'w':len(v)}
def sun():
 lg=sh("docker exec cloudy sh -c 'cat /home/cloudy/.config/sunshine/sunshine.log /cloudy/conf/sunshine/sunshine.log 2>/dev/null | tail -n 400'")
 o=lg+sh('docker logs --tail 400 cloudy 2>&1')
 return{'e':[x[-160:]for x in re.findall(r'(?:Error|Fatal): [^\n]*',o)][-3:],'x':len(re.findall("exited: sunshine",o)),'l':[x[-160:]for x in lg.split('\n')if x.strip()][-3:]}
def sset():
 lg=sh("docker exec cloudy sh -c 'cat /cloudy/log/sunshine.log /home/cloudy/.config/sunshine/sunshine.log 2>/dev/null | tail -n 1500'")
 g=lambda p:(re.findall(p,lg)or[None])[-1]
 b=g(r'Streaming bitrate is (\d+)');rs=g(r'(\d{3,5}x\d{3,5})');fr=g(r'(?:[Ff]rame ?rate|fps)[^0-9\n]{0,12}(\d{2,3})')
 r={'b':n(int(b)/1e6)if b else None,'e':g(r'Creating encoder \[([A-Za-z0-9_]+)\]'),'d':g(r'Color depth: (\d+)-bit'),'r':rs,'f':int(fr)if fr else None}
 return r if any(v is not None for v in r.values())else None
def psi():
 o=[]
 for f in('cpu','memory','io'):
  m=re.search(r'some avg10=([0-9.]+)',rd('/proc/pressure/'+f));o.append(n(m.group(1))if m else None)
 return o if any(x is not None for x in o)else None
def cli():
 for l in rd('/proc/net/nf_conntrack').split('\n'):
  if'dport=47999 'in l or'dport=47998 'in l:
   m=re.search(r'src=([0-9.]+) dst=',l)
   if m and not m.group(1).startswith(('127.','10.','172.17.')):return m.group(1)
 return None
def rtt():
 ip=cli()
 if not ip:return None
 o=sh('ping -c 4 -i 0.2 -W 1 '+ip)
 a=re.search(r'= [0-9.]+/([0-9.]+)/[0-9.]+/([0-9.]+)',o);l=re.search(r'([0-9.]+)% packet loss',o)
 if not a or not l or n(l.group(1))>=100:return{'o':1}
 return{'r':n(a.group(1)),'j':n(a.group(2)),'l':n(l.group(1))}
def gpp():
 try:
  import xml.etree.ElementTree as E
  P=[]
  for p in E.fromstring(sh('nvidia-smi -q -x')).iter('process_info'):
   i=(p.findtext('pid')or'').strip();m=re.match(r'(\d+)',p.findtext('used_memory')or'')
   P.append([i,((p.findtext('process_name')or'').strip().split('/')[-1]or rd('/proc/'+i+'/comm').strip()or'?')[:40],int(m.group(1))if m else 0])
  if not P:return None
  sm={}
  for l in sh('nvidia-smi pmon -c 1 -s u').split('\n'):
   f=l.split()
   if len(f)>4 and f[1].isdigit():sm[f[1]]=n(f[3])
  return[[a[1],a[2],sm.get(a[0])]for a in sorted(P,key=lambda a:-a[2])[:4]]
 except Exception:return None
def spot():
 v=rd('/sys/class/dmi/id/sys_vendor')+rd('/sys/class/dmi/id/product_name')
 if'Google'in v:
  if sh("curl -s -m 1 -H 'Metadata-Flavor: Google' http://metadata.google.internal/computeMetadata/v1/instance/preempted")=='TRUE':return'preempted'
  e=sh("curl -s -m 1 -H 'Metadata-Flavor: Google' http://metadata.google.internal/computeMetadata/v1/instance/maintenance-event")
  return'maintenance'if e not in('','NONE')and len(e)<40 else None
 if'Amazon'in v:
  t=sh("curl -s -m 1 -X PUT -H 'X-aws-ec2-metadata-token-ttl-seconds: 60' http://169.254.169.254/latest/api/token")
  return'terminate'if t and'"action"'in sh("curl -s -m 1 -H 'X-aws-ec2-metadata-token: "+t+"' http://169.254.169.254/latest/meta-data/spot/instance-action")else None
 if'Microsoft'in v:
  return'preempt'if'Preempt'in sh("curl -s -m 1 -H Metadata:true 'http://169.254.169.254/metadata/scheduledevents?api-version=2020-07-01'")else None
 return None
def grow():
 for p in sh('ls /sys/class/block/*/device/rescan 2>/dev/null').split():
  try:open(p,'w').write('1')
  except Exception:pass
 s=sh('findmnt -no SOURCE /');k=sh('lsblk -no PKNAME '+s+' | head -1');q=rd('/sys/class/block/'+os.path.basename(s)+'/partition').strip()
 if k and q and sp.run('growpart /dev/'+k+' '+q,shell=True,capture_output=True).returncode==0:sh('resize2fs '+s+' || xfs_growfs /')
c0,n0,d0,t0,i,gm,cm,u0=cpu(),net(),dio(),time.time(),0,0,0,udp()
while 1:
 time.sleep(3);i+=1;c=cpu()
 cm=max(cm,100*(1-(c[1]-c0[1])/max(1,c[0]-c0[0])))if i%5 else cm
 if i%5:continue
 g=gpu()if'healthy'==sh("docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{end}}' cloudy 2>/dev/null")or not sh('docker ps -q -f name=cloudy')else None
 if g and g.get('u')is not None:gm=max(gm,g['u'])
 if i%100==5:
  grow();s=os.statvfs('/');out('CLOUDGAMING_DISK %d %d %d'%((s.f_blocks-s.f_bfree)*s.f_frsize>>20,s.f_blocks*s.f_frsize>>20,time.time()))
 if i%200==5:
  x=re.findall(r'CLOUDGAMING_STAGE[^\n]*',rd('/var/log/cloudgaming-setup.log')[-30000:])
  if x:out(x[-1])
 nt,d,t=net(),dio(),time.time();dt=t-t0
 m={l.split(':')[0]:int(l.split()[1])for l in rd('/proc/meminfo').split('\n')if l}
 j=sh('journalctl -k -b --no-pager -q');s=os.statvfs('/');tz=[int(x)/1000 for x in(rd(p).strip()for p in sh('ls /sys/class/thermal/thermal_zone*/temp 2>/dev/null').split())if x]
 if g:g['um']=gm
 dc=max(1,c[0]+c[2]-c0[0]-c0[2]);ud=udp();cr=[100*(1-(a[1]-b[1])/max(1,a[0]-b[0]))for a,b in zip(c[4],c0[4])]
 st=g is not None and g.get('es')
 out('CGT '+json.dumps({'t':int(t),'c':n(100*(1-(c[1]-c0[1])/max(1,c[0]-c0[0]))),'cm':n(cm),'l':n(rd('/proc/loadavg').split()[0]),
  'm':[n((m['MemTotal']-m['MemAvailable'])/1048576),n(m['MemTotal']/1048576)],'sw':n((m.get('SwapTotal',0)-m.get('SwapFree',0))/1048576),
  'd':[n((s.f_blocks-s.f_bfree)*s.f_frsize/2**30),n(s.f_blocks*s.f_frsize/2**30)],'dr':n((d[0]-d0[0])/dt/2**20),'dw':n((d[1]-d0[1])/dt/2**20),
  'ni':n((nt[0]-n0[0])*8/dt/1e6),'no':n((nt[1]-n0[1])*8/dt/1e6),'g':g,'gf':fps(),'sn':sun()if i%20==0 else None,'ss':sset()if st and i%20==0 else None,'cc':[n(max(cr)),len(cr)]if cr else None,'cs':n(100*(c[2]-c0[2])/dc),'cw':n(100*(c[3]-c0[3])/dc),'pr':psi(),
  'dl':[n((d[3]-d0[3])/(d[2]-d0[2])if d[2]>d0[2]else 0),n((d[5]-d0[5])/(d[4]-d0[4])if d[4]>d0[4]else 0),d[6]],'ne':[nt[2]-n0[2],nt[3]-n0[3],ud-u0],'tx':n(nt[1]/2**30),'rt':rtt()if st else None,'gp':gpp()if g else None,'sp':spot(),'ct':max(tz)if tz else None,'up':n(rd('/proc/uptime').split()[0]),
  'x':len(re.findall('NVRM: Xid',j)),'xl':(re.findall(r'NVRM: Xid[^\n]{0,160}',j)or[None])[-1],'o':len(re.findall('Out of memory: Killed',j)),
  'f':sh("systemctl --failed --no-legend --plain | awk '{print $1}'").split(),'k':[x for x in sh("docker ps -a --format '{{.Names}}: {{.Status}}'").split('\n')if x],
  'p':[l.split(None,1)[::-1]for l in sh("top -bn2 -d0.5 -o %CPU -w 200 | awk '/^top -/{f++} f==2 && $1~/^[0-9]+$/{print $9, $12}' | head -3").split('\n')if l.strip()]},separators=(',',':')))
 c0,n0,d0,t0,gm,cm,u0=c,nt,d,t,0,0,ud
`;

/** sha256 of the file as written on the machine (source + trailing newline). */
export const AGENT_SHA256 = crypto.createHash('sha256').update(AGENT_SOURCE).digest('hex');
