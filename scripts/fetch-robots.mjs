// Fetches the robot models for `npm run test:robots` into data/ (not part of the repository):
//
//  - data/collada-robots: the COLLADA 1.5 robots of github.com/rdiankov/collada_robots
//    (OpenRAVE writer and a CATIA plug-in, 2014; the repository states no licence, so they
//    stay local), unpacked from .zae.
//  - data/urdf: robots converted from URDF with collada_urdf in a ROS Noetic container
//    (needs Docker): Franka Panda with hand (franka_ros, Apache-2.0), Universal Robots UR5e
//    (ros-industrial/universal_robot, Apache-2.0/BSD-3), ABB IRB 2400 (ros-industrial/abb,
//    BSD-3). The URDF files are kept next to them as the reference for the test, and
//    robots.aml places the three side by side for the viewer.
//
//   node scripts/fetch-robots.mjs [--no-docker]

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const data = path.join(root, 'data');
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: 'inherit', ...opts });

// ---- collada_robots --------------------------------------------------------------------------
const robots = path.join(data, 'collada-robots');
if (!fs.existsSync(robots)) run('git', ['clone', '--depth', '1', 'https://github.com/rdiankov/collada_robots.git', robots]);
for (const zae of fs.readdirSync(robots).filter(f => f.endsWith('.zae'))) {
  const dir = path.join(robots, 'dae', zae.replace(/\.zae$/, ''));
  if (fs.existsSync(dir)) continue;
  fs.mkdirSync(dir, { recursive: true });
  // .zae is a zip file; tar reads zip on Windows 10+ and on most Linux systems.
  try { run('tar', ['-xf', path.join(robots, zae), '-C', dir]); }
  catch { run('unzip', ['-o', '-q', path.join(robots, zae), '-d', dir]); }
}
console.log(`collada_robots: ${fs.readdirSync(path.join(robots, 'dae')).length} robots in ${path.relative(root, robots)}/dae`);

// ---- URDF robots through collada_urdf ------------------------------------------------------------
if (!process.argv.includes('--no-docker')) {
  const out = path.join(data, 'urdf');
  fs.mkdirSync(out, { recursive: true });
  const script = [
    'set -e',
    'apt-get update -qq',
    'DEBIAN_FRONTEND=noninteractive apt-get install -y -qq ros-noetic-collada-urdf ros-noetic-xacro ros-noetic-franka-description ros-noetic-ur-description ros-noetic-abb-irb2400-support > /dev/null',
    'source /opt/ros/noetic/setup.bash',
    'cd /out',
    'xacro $(rospack find franka_description)/robots/panda/panda.urdf.xacro hand:=true > panda.urdf',
    'xacro $(rospack find ur_description)/urdf/ur5e.xacro > ur5e.urdf',
    'xacro $(rospack find abb_irb2400_support)/urdf/irb2400.xacro > irb2400.urdf',
    'for r in panda ur5e irb2400; do rosrun collada_urdf urdf_to_collada $r.urdf $r.dae; done',
  ].join(' && ');
  run('docker', ['run', '--rm', '-v', `${out}:/out`, 'ros:noetic-ros-base', 'bash', '-c', script]);

  // The three robots side by side, 1.5 m apart.
  const ie = (name, file, x) => `
    <InternalElement Name="${name}" ID="${name}">
      <Attribute Name="Frame"><Attribute Name="x"><Value>${x}</Value></Attribute><Attribute Name="y"><Value>0</Value></Attribute><Attribute Name="z"><Value>0</Value></Attribute>
        <Attribute Name="rx"><Value>0</Value></Attribute><Attribute Name="ry"><Value>0</Value></Attribute><Attribute Name="rz"><Value>0</Value></Attribute></Attribute>
      <ExternalInterface Name="Representation" ID="${name}_rep" RefBaseClassPath="AutomationMLInterfaceClassLib/AutomationMLBaseInterface/ExternalDataConnector/COLLADAInterface">
        <Attribute Name="refURI"><Value>${file}</Value></Attribute><Attribute Name="refType"><Value>explicit</Value></Attribute>
      </ExternalInterface>
    </InternalElement>`;
  fs.writeFileSync(path.join(out, 'robots.aml'), `<?xml version="1.0" encoding="utf-8"?>
<CAEXFile SchemaVersion="3.0" FileName="robots.aml" xmlns="http://www.dke.de/CAEX">
  <InstanceHierarchy Name="Robots" ID="robots">${ie('Panda', 'panda.dae', -1.5)}${ie('UR5e', 'ur5e.dae', 0)}${ie('IRB2400', 'irb2400.dae', 1.5)}
  </InstanceHierarchy>
</CAEXFile>
`);
  console.log(`URDF robots: panda, ur5e, irb2400 in ${path.relative(root, out)} (robots.aml shows them)`);
}
