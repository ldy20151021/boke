---
title: 用 PVE+Tailscale+Guacamole+VPS 自建浏览器云桌面
date: 2026-08-08 22:00:00 +0800
categories: [Homelab]
tags: [PVE,VDI,Tailscale,Guacamole]
---

# 用 PVE + Tailscale + Guacamole + VPS 自建浏览器云桌面

一条完整的自建 VDI 链路：家里 PVE 宿主机跑 Windows 11 桌面 VM，Guacamole 把 RDP 收口成 HTML5，Tailscale 组成私有网络，VPS 负责对外入口。最终效果：任何浏览器打开 HTTPS 地址就能进 Windows 桌面。

## 一、整体拓扑

```
外网浏览器
   │ HTTPS
   ▼
VPS(公网IP) ── Nginx Proxy Manager ──┐
   │ Tailscale                       │
   │                                 │
家里 PVE 宿主机                      │
   ├─ LXC(101) Tailscale Subnet Router (宣告 192.168.1.0/24)
   ├─ LXC(102) Guacamole (Docker: guacd+web+mysql)  ← NPM 反代到这
   └─ VM(100) Windows 11 桌面 (开 RDP 3389)
          ▲ Guacamole 用 RDP 协议连 VM 的 192.168.1.x:3389
PVE 8006 只放 Tailscale 网段，不进 VPS、不进公网
```

链路：外网浏览器 → VPS(NPM) → Tailscale 隧道 → LXC(102) Guacamole → RDP → VM(100) Windows。

PVE 的 8006 管理口只允许 Tailscale 网段访问，VPS 不碰它，公网也摸不到它。

## 二、PVE 安装要点

1. 官网下载 8.x ISO，用 Ventoy 写入 U 盘，机器从 U 盘启动。
2. 安装时配置固定 IP，例如 `192.168.1.10/24`，不要用 DHCP。
3. Hostname 填 `pve.lan`，DNS 填路由器或 `223.5.5.5`。
4. 装完浏览器访问 `https://192.168.1.10:8006`。
5. 换国内软件源（常规操作，略）。
6. 装 Tailscale 前先决定它跑在宿主机还是 LXC：推荐用 LXC 跑 subnet router，不污染宿主机系统。

## 三、LXC(101) 跑 Tailscale Subnet Router

在 PVE 宿主机 Shell 创建容器：

```bash
pct create 101 local:vztmpl/debian-12-standard_amd64.tar.zst --hostname ts-router \
  --cores 1 --memory 256 --storage local-lvm --net0 name=eth0,bridge=vmbr0,ip=192.168.1.11/24,gw=192.168.1.1
```

在 `/etc/pve/lxc/101.conf` 末尾追加 tun 设备配置（Tailscale 需要）：

```conf
lxc.cgroup2.devices.allow: c 10:200 rwm
lxc.mount.entry: /dev/net/tun dev/net/tun none bind,create=file
```

启动容器，进入 console 安装 Tailscale 并宣告子网路由：

```bash
apt update && apt install curl -y
curl -fsSL https://tailscale.com/install.sh | sh
echo 'net.ipv4.ip_forward=1' >> /etc/sysctl.conf && sysctl -p
tailscale up --advertise-routes=192.168.1.0/24
```

去 Tailscale Admin 后台批准这条路由。批准后，Tailscale 网络内任意节点都能访问 `192.168.1.0/24` 网段。

## 四、PVE 建 Windows 云桌面 VM（关键：出画面）

PVE 网页端创建 VM：

- 名称 `win-desk`
- BIOS 选 OVMF + UEFI，机型 q35
- 添加 TPM 2.0 设备（Windows 11 必需）
- 磁盘用 VirtIO Block，挂载 virtio-win ISO 作为第二光驱
- 网络用 VirtIO paravirt，桥接 vmbr0
- 内存 8G，CPU 4 核，type 选 host
- 显示先用 Default 或 VirtIO-GPU，装完系统再切

装系统时提示"找不到硬盘"：加载 virtio 驱动 `vioscsi\w11\amd64`。

装完进桌面后：

1. 运行 `virtio-win-gt-x64.msi`，全量安装 VirtIO 驱动。
2. 安装 `guest-agent\qemu-ga-x86_64.msi` 客户机代理。
3. 设置 → 系统 → 远程桌面 → 开启（注意：Win11 家庭版没有 RDP 服务端，需要用 Pro 版）。
4. 设置固定内网 IP，如 `192.168.1.100`。
5. 防火墙放行 3389 入站（实验阶段也可以直接关闭专用网络防火墙）。

验证：用家里另一台电脑 `mstsc` 连 `192.168.1.100`，能进桌面就说明 VM 侧已经 OK。

## 五、LXC(102) Guacamole（把 RDP 收口成 HTML5）

LXC 102 装 Debian 12，安装 Docker：

```bash
apt install docker.io docker-compose -y
mkdir -p /opt/guac && cd /opt/guac
```

`docker-compose.yml`：

```yaml
version: '3'
services:
  guacd:
    image: guacamole/guacd:1.5.5
    restart: always
  mysql:
    image: mysql:8.0
    restart: always
    environment:
      MYSQL_ROOT_PASSWORD: rootpass
      MYSQL_DATABASE: guacamole_db
      MYSQL_USER: guac
      MYSQL_PASSWORD: guacpass
    volumes:
      - ./db:/var/lib/mysql
  guacamole:
    image: guacamole/guacamole:1.5.5
    restart: always
    ports:
      - "8080:8080"
    environment:
      GUACD_HOSTNAME: guacd
      MYSQL_HOSTNAME: mysql
      MYSQL_DATABASE: guacamole_db
      MYSQL_USER: guac
      MYSQL_PASSWORD: guacpass
    depends_on:
      - guacd
      - mysql
```

启动：

```bash
docker compose up -d
```

浏览器临时验证：`http://192.168.1.12:8080/guacamole`（假设 LXC 102 的 IP 是 `192.168.1.12`），默认账号 `guacadmin/guacadmin`，登录后立刻改密。

后台新建连接：

- Protocol: RDP
- Hostname: `192.168.1.100`（Windows VM 的 IP）
- Port: 3389
- Username / Password: Windows 账号
- 启用 RDP 相关增强参数，颜色深度 16-bit，禁用桌面壁纸（disable wallpaper）

保存后回到主页点开连接，能出现 Windows 桌面就说明 Guacamole 通了。

## 六、VPS 中转（公网入口）

VPS（Ubuntu/Debian，有公网 IP）：

```bash
curl -fsSL https://tailscale.com/install.sh | sh
tailscale up
```

VPS 也加入同一个 tailnet。再装 Docker 和 Nginx Proxy Manager（compose 配置略）。

NPM 里新建 Proxy Host：

- 域名：`desktop.你的二级域名.com`
- Forward to：`100.x.y.z:8080`（填 Guacamole LXC 的 **Tailscale IP**，不是 `192.168.1.12`——因为 VPS 走 Tailscale 隧道进内网）
- 开启 WebSocket
- SSL：Let's Encrypt + Force SSL

DNS 配置：A 记录 `desktop.你的二级域名.com` → VPS 公网 IP。

完成后，外面手机浏览器打开 `https://desktop.你的二级域名.com/guacamole`，能进登录页，登录后看到 Windows 桌面。

## 七、安全收尾

- PVE 8006 只在 Tailscale 网段开放，VPS 与公网都不暴露它。
- Guacamole 默认账号立即改密，Windows 账号用强密码。
- 整个内网访问都走 Tailscale 加密隧道，公网只留 NPM 一个 HTTPS 入口。

至此全链路打通：浏览器 → VPS(NPM) → Tailscale → Guacamole → RDP → Windows 桌面。
