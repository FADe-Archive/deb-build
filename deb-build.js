#!/usr/bin/env node

const fs = require('fs');
const tar = require('tar-stream');
const tmpjs = require('tmp');
const targz = require('targz');
const rimraf = require('rimraf');
const zlib = require('zlib');

/* deb-build Module
 * This Subproject is part of FADe Project
 * Copyright (C) ldmsys, License subject by main project
 * (Currently MIT License)
 */

const types = {
    systemd: 'systemd',
    isolated: 'isolated',
    normal: 'normal'
};

let data_tar_gz_datadir = "";

function generate_ar_header(filename, timestamp, owner_id, group_id, filemode, filesize) {
	// REF: https://en.wikipedia.org/wiki/Ar_%28Unix%29
    let buf = Buffer.alloc(60, 0x20); // fill with space

    buf.write(filename.toString(), 0); // 0 - 16 byte: File Name
    buf.write(timestamp.toString(), 16); // 16 - 28 byte: Timestamp (1972-11-21 = 91152000)
    buf.write(owner_id.toString(), 28); // 28 - 34 byte: Owner ID
    buf.write(group_id.toString(), 34); // 34 - 40 byte: Group ID
    buf.write(filemode.toString(), 40); // 40 - 48 byte: File Mode (WARNING: OCTAL!!)
    buf.write(filesize.toString(), 48); // 48 - 58 byte: File Size
    buf.write('`\n', 58); // 58 - 60 Byte: End of Header
    return buf;
}
function promise_targz_compress(opt) {
    return new Promise((res, rej) => {
        targz.compress(opt, (err) => {
            if(err) return rej(err);
            res();
        });
    });
}
function generate_deb_control(name, version, maintainer_name, maintainer_email, depends, architecture, priority, url, desc) {
    return `Package: ${name}
Version: ${version}
Priority: ${priority}
Architecture: ${architecture}
Maintainer: ${maintainer_name} <${maintainer_email}>
Depends: ${depends}
Homepage: ${url}
Description: ${desc}\n`;
}
function generate_deb_postinst(name, version, desc, cmdline, type, maintainer_name, maintainer_email, postinst_payload) {
    let str = "#!/bin/bash\n";
    if (type == types.systemd || type == types.isolated) {
        str += `useradd -r -s /sbin/nologin -g nogroup -d /usr/lib/${name} -c "${desc}" ${name}
chown -R ${name}:root /usr/lib/${name}\n`;
    }
    str += `echo "${name} v${version} by ${maintainer_name} <${maintainer_email}>"
${postinst_payload}\n`;
    if (type == types.systemd) {
        str += `cat >> /lib/systemd/system/${name}.service << EOF
[Unit]
Description=${desc}

[Service]
Type=simple
User=${name}
WorkingDirectory=/usr/lib/${name}
ExecStart=/bin/bash -c "cd /usr/lib/${name};${cmdline}"

[Install]
WantedBy=multi-user.target
EOF
chmod 644 /lib/systemd/system/${name}.service
systemctl daemon-reload
systemctl enable ${name}
systemctl start ${name}`;
    }
    //.replace(/"/g,"\\\"").replace(/'/g,"\\\'")
    return str;
}
function generate_deb_prerm(name, type, prerm_payload) {
    let str = `#!/bin/bash
${prerm_payload}\n`;
    if(type == types.systemd) {
        str += `systemctl stop ${name}
systemctl disable ${name}
rm /lib/systemd/system/${name}.service
systemctl daemon-reload\n`;
    }
    if(type == types.systemd || type == types.isolated)
        str += `userdel ${name}\n`;
    str += `rm /usr/lib/${name}
mkdir /usr/lib/${name}`;
    return str;
}

function generate_control_targz(control, postinst, prerm) {
    return new Promise((res, rej) => {
        let tmpTar;
        let tmparr = [];
        let pack = tar.pack();

        pack.entry({
            name: "control",
            uid: 0,
            gid: 0,
            mode: 0o644
        }, control);
        pack.entry({
            name: "postinst",
            uid: 0,
            gid: 0,
            mode: 0o755
        }, postinst);
        pack.entry({
            name: "prerm",
            uid: 0,
            gid: 0,
            mode: 0o755
        }, prerm, () => {
            pack.finalize();
        });
        pack.on('data', (buf) => {
            tmparr.push(buf);
        });
        pack.on('end', () => {
            tmpTar = Buffer.concat(tmparr);
            res(zlib.gzipSync(tmpTar));
        });
    });
}

exports.generate_ar_header = generate_ar_header;
exports.build = (name, version, desc, url, architecture, depends, priority, run, maintainer_name, maintainer_email, type, postinst_payload, prerm_payload) => {
    return new Promise((res, rej) => {
        let commadeps = "";
        if(typeof depends == "object") {
           depends.forEach((item, index) => {
                commadeps += (index != 0)?", ":"";
                commadeps += item;
           });
        }else commadeps = depends;
        let control = generate_deb_control(name, version, maintainer_name, maintainer_email, commadeps, architecture, priority, url, desc);
        let postinst = generate_deb_postinst(name, version, desc, run, type, maintainer_name, maintainer_email, postinst_payload)
        let prerm = generate_deb_prerm(name, type, prerm_payload);
        let magic_header = Buffer.from("!<arch>\n");
        let debian_binary_data = Buffer.from("2.0\n");
        let debian_binary_header = generate_ar_header("debian-binary", Math.floor(Date.now()/1000), 0, 0, 100644, debian_binary_data.length);
        generate_control_targz(control, postinst, prerm).then((control_tar_gz_data) => {
            let data_tar_gz_tempFile = tmpjs.tmpNameSync();
            promise_targz_compress({src: data_tar_gz_datadir.name, dest: data_tar_gz_tempFile, tar: {entries: ["."], uid: 0, gid: 0}}).then(() => {
                data_tar_gz_data = fs.readFileSync(data_tar_gz_tempFile);
                fs.unlinkSync(data_tar_gz_tempFile);
                rimraf.sync(data_tar_gz_datadir.name);
                data_tar_gz_datadir = tmpjs.dirSync();
                if (control_tar_gz_data.length % 2 !== 0) {
                    control_tar_gz_data = Buffer.concat([control_tar_gz_data, Buffer.alloc(1,0)],control_tar_gz_data.length+1);
                }
                if (data_tar_gz_data.length % 2 !== 0) {
                    data_tar_gz_data = Buffer.concat([data_tar_gz_data, Buffer.alloc(1,0)],data_tar_gz_data.length+1);
                }
                let control_tar_gz_header = generate_ar_header("control.tar.gz", Math.floor(Date.now()/1000), 0, 0, 100644, control_tar_gz_data.length);
                let data_tar_gz_header = generate_ar_header("data.tar.gz", Math.floor(Date.now()/1000), 0, 0, 100644, data_tar_gz_data.length);
                let totalLength = magic_header.length + debian_binary_header.length + debian_binary_data.length + control_tar_gz_header.length
                                + control_tar_gz_data.length + data_tar_gz_header.length + data_tar_gz_data.length;
                res(Buffer.concat([magic_header, debian_binary_header, debian_binary_data, control_tar_gz_header,
                                    control_tar_gz_data, data_tar_gz_header, data_tar_gz_data], totalLength));
            });
        });
    });
};
exports.set_data_tar_gz_datadir = () => {
    data_tar_gz_datadir = tmpjs.dirSync();
    return data_tar_gz_datadir;
};
exports.get_data_tar_gz_datadir = () => {
    return data_tar_gz_datadir;
};
exports.types = types;
exports.generate_control_targz = generate_control_targz;