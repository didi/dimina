use base64::{engine::general_purpose::STANDARD, Engine};
use btleplug::{
    api::{
        Central, CentralEvent, CentralState, CharPropFlags, Characteristic, Manager as _,
        Peripheral as _, RetrievePeripheralsOptions, ScanFilter, ValueNotification, WriteType,
    },
    platform::{Adapter, Manager, Peripheral},
};
use futures_util::StreamExt;
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    collections::{BTreeSet, HashMap, HashSet},
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    sync::{mpsc, Mutex},
    task::JoinHandle,
};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

type Result<T> = std::result::Result<T, (i32, String)>;
fn error(code: i32, message: impl ToString) -> (i32, String) {
    (code, message.to_string())
}
fn field<'a>(v: &'a Value, key: &str) -> &'a str {
    v[key].as_str().unwrap_or("")
}
fn uuid(v: &str) -> Result<Uuid> {
    let v = match v.len() {
        4 => format!("0000{v}-0000-1000-8000-00805f9b34fb"),
        8 => format!("{v}-0000-1000-8000-00805f9b34fb"),
        _ => v.to_owned(),
    };
    Uuid::parse_str(&v).map_err(|e| error(10013, e))
}
fn uuids(v: &Value) -> Result<Vec<Uuid>> {
    v.as_array()
        .map(|v| v.iter().map(|v| uuid(v.as_str().unwrap_or(""))).collect())
        .unwrap_or(Ok(vec![]))
}
fn binary(v: &[u8]) -> Value {
    json!({"__diminaArrayBufferBase64":STANDARD.encode(v)})
}
#[derive(Deserialize)]
struct Request {
    id: String,
    owner: String,
    method: String,
    #[serde(default)]
    params: Value,
    #[serde(default = "default_operation_timeout")]
    timeout_ms: u64,
}
fn default_operation_timeout() -> u64 {
    20000
}
async fn await_operation<T>(
    cancel: &CancellationToken,
    timeout: Duration,
    operation: impl std::future::Future<Output = Result<T>>,
) -> Result<T> {
    tokio::select! {
        biased;
        _=cancel.cancelled()=>Err(error(10006,"Bluetooth operation cancelled")),
        result=tokio::time::timeout(timeout,operation)=>result.unwrap_or_else(|_|Err(error(10012,"Bluetooth operation timed out"))),
    }
}
#[derive(Default)]
struct Owner {
    scanning: bool,
    services: Vec<Uuid>,
    duplicates: bool,
    interval: Duration,
    seen: HashMap<String, Instant>,
    devices: HashSet<String>,
    connections: HashSet<String>,
    notifications: HashMap<String, JoinHandle<()>>,
}
struct State {
    adapter: Option<Adapter>,
    owners: HashMap<String, Owner>,
    known: HashMap<String, Peripheral>,
    closed: HashSet<String>,
    output: mpsc::UnboundedSender<Value>,
}
impl State {
    fn event(&self, owner: &str, event: &str, value: Value) {
        let _ = self
            .output
            .send(json!({"owner":owner,"event":event,"value":value}));
    }
    async fn adapter(&self, owner: &str) -> Result<Adapter> {
        if !self.owners.contains_key(owner) {
            return Err(error(10000, "Bluetooth adapter is not initialized"));
        }
        let a = self
            .adapter
            .clone()
            .ok_or(error(10001, "Bluetooth adapter unavailable"))?;
        if a.adapter_state().await.map_err(|e| error(10001, e))? != CentralState::PoweredOn {
            return Err(error(
                10001,
                "Bluetooth adapter is powered off or permission was denied",
            ));
        }
        Ok(a)
    }
    async fn peripheral(&self, owner: &str, id: &str, connected: bool) -> Result<Peripheral> {
        let a = self.adapter(owner).await?;
        let o = &self.owners[owner];
        if !o.devices.contains(id) || (connected && !o.connections.contains(id)) {
            return Err(error(
                if connected { 10006 } else { 10002 },
                "Device is not owned by this mini program",
            ));
        }
        let known = self.known.get(id).ok_or(error(10002, "Device not found"))?;
        if let Ok(device) = a.peripheral(&known.id()).await {
            return Ok(device);
        }
        // CoreBluetooth releases disconnected peripherals. Retrieve the known ID
        // again rather than requiring the mini program to restart discovery.
        a.retrieve_peripherals(RetrievePeripheralsOptions {
            identifiers: Some(vec![known.id()]),
            services: None,
        })
        .await
        .map_err(|e| error(10002, e))?
        .into_iter()
        .find(|device| device.id().to_string() == id)
        .ok_or(error(10002, "Device not found"))
    }
    async fn characteristic(&self, owner: &str, p: &Value) -> Result<(Peripheral, Characteristic)> {
        let device = self.peripheral(owner, field(p, "deviceId"), true).await?;
        let service = uuid(field(p, "serviceId"))?;
        if !device.services().iter().any(|s| s.uuid == service) {
            return Err(error(10004, "Service not found"));
        }
        let id = uuid(field(p, "characteristicId"))?;
        let c = device
            .characteristics()
            .into_iter()
            .find(|c| c.service_uuid == service && c.uuid == id)
            .ok_or(error(10005, "Characteristic not found"))?;
        Ok((device, c))
    }
    async fn close(&mut self, owner: &str) {
        if let Some(o) = self.owners.remove(owner) {
            for (_, task) in o.notifications {
                task.abort();
            }
            // Disconnect all owned peripherals together, bounded by one cleanup
            // interval rather than an interval for every connected device.
            let devices: Vec<_> = o
                .connections
                .iter()
                .filter_map(|id| self.known.get(id).cloned())
                .collect();
            let stop_scan = if !self.owners.values().any(|o| o.scanning) {
                self.adapter.clone()
            } else {
                None
            };
            tokio::join!(
                async {
                    futures_util::future::join_all(devices.into_iter().map(|device| async move {
                        let _ =
                            tokio::time::timeout(Duration::from_secs(5), device.disconnect()).await;
                    }))
                    .await;
                },
                async {
                    if let Some(adapter) = stop_scan {
                        let _ =
                            tokio::time::timeout(Duration::from_secs(5), adapter.stop_scan()).await;
                    }
                }
            );
        }
    }
    async fn invoke(&mut self, request: &Request, shared: Arc<Mutex<State>>) -> Result<Value> {
        let owner = &request.owner;
        let p = &request.params;
        let method = request.method.as_str();
        if method == "__closeOwner" {
            self.close(owner).await;
            self.closed.insert(owner.clone());
            return Ok(json!({}));
        }
        if self.closed.contains(owner) {
            return Err(error(10000, "Window is closed"));
        }
        if method == "closeBluetoothAdapter" {
            self.close(owner).await;
            return Ok(json!({}));
        }
        if method == "openBluetoothAdapter" {
            if field(p, "mode") == "peripheral" {
                return Err(error(10009, "Only BLE central mode is supported"));
            }
            if self.adapter.is_none() {
                let manager = Manager::new().await.map_err(|e| error(10001, e))?;
                let a = manager
                    .adapters()
                    .await
                    .map_err(|e| error(10001, e))?
                    .into_iter()
                    .next()
                    .ok_or(error(10001, "No Bluetooth adapter"))?;
                let mut events = a.events().await.map_err(|e| error(10001, e))?;
                tokio::spawn(async move {
                    while let Some(event) = events.next().await {
                        handle_event(shared.clone(), event).await;
                    }
                });
                self.adapter = Some(a);
            }
            // Keep an initialized owner while powered off so state subscriptions still work.
            self.owners.entry(owner.clone()).or_default();
            self.adapter(owner).await?;
            return Ok(json!({}));
        }
        if method == "getBluetoothAdapterState" {
            let o = self
                .owners
                .get(owner)
                .ok_or(error(10000, "Bluetooth adapter is not initialized"))?;
            let available = match &self.adapter {
                Some(a) => {
                    a.adapter_state().await.map_err(|e| error(10001, e))? == CentralState::PoweredOn
                }
                None => false,
            };
            return Ok(json!({"available":available,"discovering":available&&o.scanning}));
        }
        let a = self.adapter(owner).await?;
        match method {
            "startBluetoothDevicesDiscovery" => {
                let services = uuids(&p["services"])?;
                let interval = p["interval"].as_u64().unwrap_or(0);
                if interval > 300000 {
                    return Err(error(10013, "Invalid interval"));
                }
                if !self.owners.values().any(|o| o.scanning) {
                    a.start_scan(ScanFilter::default())
                        .await
                        .map_err(|e| error(10001, e))?;
                }
                let o = self.owners.get_mut(owner).unwrap();
                o.scanning = true;
                o.services = services;
                o.duplicates = p["allowDuplicatesKey"].as_bool().unwrap_or(false);
                o.interval = Duration::from_millis(interval);
                o.seen.clear();
                self.event(
                    owner,
                    "onBluetoothAdapterStateChange",
                    json!({"available":true,"discovering":true}),
                );
                for device in a.peripherals().await.map_err(|e| error(10002, e))? {
                    discover(self, &device).await;
                }
                Ok(json!({}))
            }
            "stopBluetoothDevicesDiscovery" => {
                self.owners.get_mut(owner).unwrap().scanning = false;
                if !self.owners.values().any(|o| o.scanning) {
                    a.stop_scan().await.map_err(|e| error(10001, e))?;
                }
                self.event(
                    owner,
                    "onBluetoothAdapterStateChange",
                    json!({"available":true,"discovering":false}),
                );
                Ok(json!({}))
            }
            "getBluetoothDevices" | "getConnectedBluetoothDevices" => {
                let services = uuids(&p["services"])?;
                let mut values = vec![];
                for device in self.known.values() {
                    let id = device.id().to_string();
                    let o = &self.owners[owner];
                    if !o.devices.contains(&id)
                        || (method == "getConnectedBluetoothDevices"
                            && !o.connections.contains(&id))
                    {
                        continue;
                    }
                    if method == "getConnectedBluetoothDevices"
                        && !device.is_connected().await.map_err(|e| error(10006, e))?
                    {
                        continue;
                    }
                    if let Some(props) = device.properties().await.map_err(|e| error(10002, e))? {
                        if !services.is_empty()
                            && !services.iter().any(|s| {
                                props.services.contains(s)
                                    || device.services().iter().any(|v| v.uuid == *s)
                            })
                        {
                            continue;
                        }
                        values.push(device_value(device, &props));
                    }
                }
                Ok(json!({"devices":values}))
            }
            "createBLEConnection" => {
                let id = field(p, "deviceId");
                if self
                    .owners
                    .iter()
                    .any(|(key, o)| key != owner && o.connections.contains(id))
                {
                    return Err(error(
                        10003,
                        "Device is already used by another mini program",
                    ));
                }
                let device = self.peripheral(owner, id, false).await?;
                let timeout = p["timeout"].as_u64().unwrap_or(10000);
                if timeout == 0 || timeout > 300000 {
                    return Err(error(10013, "Invalid timeout"));
                }
                self.owners
                    .get_mut(owner)
                    .unwrap()
                    .connections
                    .insert(id.to_owned());
                if let Err(e) = device
                    .connect_with_timeout(Duration::from_millis(timeout))
                    .await
                {
                    let _ = device.disconnect().await;
                    self.owners.get_mut(owner).unwrap().connections.remove(id);
                    return Err(error(10003, e));
                }
                if let Err(e) = device
                    .discover_services_with_timeout(Duration::from_millis(timeout))
                    .await
                {
                    let _ = device.disconnect().await;
                    self.owners.get_mut(owner).unwrap().connections.remove(id);
                    return Err(error(10004, e));
                }
                Ok(json!({}))
            }
            "closeBLEConnection" => {
                let id = field(p, "deviceId");
                let device = self.peripheral(owner, id, true).await?;
                device.disconnect().await.map_err(|e| error(10006, e))?;
                let o = self.owners.get_mut(owner).unwrap();
                o.connections.remove(id);
                if let Some(task) = o.notifications.remove(id) {
                    task.abort();
                }
                // CentralEvent may arrive after ownership is removed.
                self.event(
                    owner,
                    "onBLEConnectionStateChange",
                    json!({"deviceId":id,"connected":false}),
                );
                Ok(json!({}))
            }
            "getBLEDeviceServices" => {
                let device = self.peripheral(owner, field(p, "deviceId"), true).await?;
                Ok(
                    json!({"services":device.services().iter().map(|s|json!({"uuid":s.uuid.to_string().to_uppercase(),"isPrimary":s.primary})).collect::<Vec<_>>()}),
                )
            }
            "getBLEDeviceCharacteristics" => {
                let device = self.peripheral(owner, field(p, "deviceId"), true).await?;
                let id = uuid(field(p, "serviceId"))?;
                let service = device
                    .services()
                    .into_iter()
                    .find(|s| s.uuid == id)
                    .ok_or(error(10004, "Service not found"))?;
                Ok(
                    json!({"characteristics":service.characteristics.iter().map(|c|json!({"uuid":c.uuid.to_string().to_uppercase(),"properties":{"read":c.properties.contains(CharPropFlags::READ),"write":c.properties.intersects(CharPropFlags::WRITE|CharPropFlags::WRITE_WITHOUT_RESPONSE),"notify":c.properties.contains(CharPropFlags::NOTIFY),"indicate":c.properties.contains(CharPropFlags::INDICATE),"writeNoResponse":c.properties.contains(CharPropFlags::WRITE_WITHOUT_RESPONSE),"writeDefault":c.properties.contains(CharPropFlags::WRITE)}})).collect::<Vec<_>>()}),
                )
            }
            "readBLECharacteristicValue" => {
                let (device, c) = self.characteristic(owner, p).await?;
                if !c.properties.contains(CharPropFlags::READ) {
                    return Err(error(10007, "Characteristic does not support read"));
                }
                let value = device.read(&c).await.map_err(|e| error(10008, e))?;
                self.event(owner,"onBLECharacteristicValueChange",json!({"deviceId":device.id().to_string(),"serviceId":c.service_uuid.to_string().to_uppercase(),"characteristicId":c.uuid.to_string().to_uppercase(),"value":binary(&value)}));
                Ok(json!({}))
            }
            "writeBLECharacteristicValue" => {
                let (device, c) = self.characteristic(owner, p).await?;
                let data = STANDARD
                    .decode(field(&p["value"], "__diminaArrayBufferBase64"))
                    .map_err(|e| error(10013, e))?;
                if !p["value"].is_object() {
                    return Err(error(10013, "value must be an ArrayBuffer"));
                }
                let without = match field(p, "writeType") {
                    "writeNoResponse" => true,
                    "write" => false,
                    "" => !c.properties.contains(CharPropFlags::WRITE),
                    _ => return Err(error(10013, "Invalid writeType")),
                };
                let flag = if without {
                    CharPropFlags::WRITE_WITHOUT_RESPONSE
                } else {
                    CharPropFlags::WRITE
                };
                if !c.properties.contains(flag) {
                    return Err(error(10007, "Write type is not supported"));
                }
                if data.len() > usize::from(device.mtu().saturating_sub(3)) {
                    return Err(error(10013, "Value exceeds negotiated MTU minus 3"));
                }
                device
                    .write(
                        &c,
                        &data,
                        if without {
                            WriteType::WithoutResponse
                        } else {
                            WriteType::WithResponse
                        },
                    )
                    .await
                    .map_err(|e| error(10008, e))?;
                Ok(json!({}))
            }
            "notifyBLECharacteristicValueChange" => {
                let (device, c) = self.characteristic(owner, p).await?;
                if !c
                    .properties
                    .intersects(CharPropFlags::NOTIFY | CharPropFlags::INDICATE)
                {
                    return Err(error(
                        10007,
                        "Characteristic does not support notifications",
                    ));
                }
                let id = device.id().to_string();
                if p["state"].as_bool().unwrap_or(false) {
                    if !self.owners[owner].notifications.contains_key(&id) {
                        let mut stream =
                            device.notifications().await.map_err(|e| error(10008, e))?;
                        let output = self.output.clone();
                        let event_owner = owner.clone();
                        let device_id = id.clone();
                        let characteristics = device.characteristics();
                        let task = tokio::spawn(async move {
                            while let Some(n) = stream.next().await {
                                if let Some(value) =
                                    notification_value(&device_id, &characteristics, &n)
                                {
                                    let _=output.send(json!({"owner":event_owner,"event":"onBLECharacteristicValueChange","value":value}));
                                }
                            }
                        });
                        self.owners
                            .get_mut(owner)
                            .unwrap()
                            .notifications
                            .insert(id, task);
                    }
                    device.subscribe(&c).await.map_err(|e| error(10008, e))?;
                } else {
                    device.unsubscribe(&c).await.map_err(|e| error(10008, e))?;
                }
                Ok(json!({}))
            }
            "getBLEDeviceRSSI" => {
                let d = self.peripheral(owner, field(p, "deviceId"), true).await?;
                Ok(json!({"RSSI":d.read_rssi().await.map_err(|e|error(10008,e))?}))
            }
            "getBLEMTU" => {
                let d = self.peripheral(owner, field(p, "deviceId"), true).await?;
                Ok(json!({"mtu":d.mtu()}))
            }
            "setBLEMTU" => Err(error(
                10009,
                "MTU is negotiated automatically by the desktop Bluetooth stack",
            )),
            _ => Err(error(10009, "Unsupported Bluetooth API")),
        }
    }
}
fn notification_value(
    device_id: &str,
    characteristics: &BTreeSet<Characteristic>,
    n: &ValueNotification,
) -> Option<Value> {
    let c = characteristics
        .iter()
        .find(|c| c.uuid == n.uuid && c.service_uuid == n.service_uuid)?;
    Some(
        json!({"deviceId":device_id,"serviceId":c.service_uuid.to_string().to_uppercase(),"characteristicId":n.uuid.to_string().to_uppercase(),"value":binary(&n.value)}),
    )
}
fn device_value(device: &Peripheral, p: &btleplug::api::PeripheralProperties) -> Value {
    let mut advertisement = vec![];
    let mut manufacturers: Vec<_> = p.manufacturer_data.iter().collect();
    manufacturers.sort_by_key(|(id, _)| **id);
    for (id, data) in manufacturers {
        advertisement.extend(id.to_le_bytes());
        advertisement.extend(data);
    }
    let service_data: serde_json::Map<String, Value> = p
        .service_data
        .iter()
        .map(|(id, data)| (id.to_string().to_uppercase(), binary(data)))
        .collect();
    json!({"deviceId":device.id().to_string(),"name":p.local_name.clone().unwrap_or_default(),"localName":p.local_name.clone().unwrap_or_default(),"RSSI":p.rssi,"advertisData":binary(&advertisement),"advertisServiceUUIDs":p.services.iter().map(|s|s.to_string().to_uppercase()).collect::<Vec<_>>(),"serviceData":service_data})
}
async fn discover(s: &mut State, device: &Peripheral) {
    let Ok(Some(p)) = device.properties().await else {
        return;
    };
    let id = device.id().to_string();
    s.known.insert(id.clone(), device.clone());
    let value = device_value(device, &p);
    for (owner, o) in &mut s.owners {
        if !o.scanning
            || (!o.services.is_empty() && !o.services.iter().any(|s| p.services.contains(s)))
        {
            continue;
        }
        if let Some(last) = o.seen.get(&id) {
            if !o.duplicates || last.elapsed() < o.interval {
                continue;
            }
        }
        o.seen.insert(id.clone(), Instant::now());
        o.devices.insert(id.clone());
        let _=s.output.send(json!({"owner":owner,"event":"onBluetoothDeviceFound","value":{"devices":[value.clone()]}}));
    }
}
async fn handle_event(shared: Arc<Mutex<State>>, event: CentralEvent) {
    let mut s = shared.lock().await;
    match event {
        CentralEvent::StateUpdate(state) => {
            let available = state == CentralState::PoweredOn;
            if !available {
                for o in s.owners.values_mut() {
                    o.scanning = false;
                }
            }
            for (owner, o) in &s.owners {
                s.event(
                    owner,
                    "onBluetoothAdapterStateChange",
                    json!({"available":available,"discovering":available&&o.scanning}),
                );
            }
        }
        CentralEvent::DeviceDisconnected(id) => {
            let id = id.to_string();
            let mut owners = vec![];
            for (owner, o) in &mut s.owners {
                if o.connections.remove(&id) {
                    if let Some(task) = o.notifications.remove(&id) {
                        task.abort();
                    }
                    owners.push(owner.clone());
                }
            }
            for owner in owners {
                s.event(
                    &owner,
                    "onBLEConnectionStateChange",
                    json!({"deviceId":id,"connected":false}),
                );
            }
        }
        CentralEvent::DeviceConnected(id) => {
            for (owner, o) in &s.owners {
                if o.connections.contains(&id.to_string()) {
                    s.event(
                        owner,
                        "onBLEConnectionStateChange",
                        json!({"deviceId":id.to_string(),"connected":true}),
                    );
                }
            }
        }
        CentralEvent::DeviceDiscovered(id)
        | CentralEvent::DeviceUpdated(id)
        | CentralEvent::ServicesAdvertisement { id, .. }
        | CentralEvent::ManufacturerDataAdvertisement { id, .. }
        | CentralEvent::ServiceDataAdvertisement { id, .. }
        | CentralEvent::RssiUpdate { id, .. } => {
            if let Some(a) = &s.adapter {
                if let Ok(device) = a.peripheral(&id).await {
                    discover(&mut s, &device).await;
                }
            }
        }
        _ => {}
    }
}
type PendingOperations = HashMap<String, (String, CancellationToken)>;
fn cancel_operation(pending: &PendingOperations, owner: &str, id: &str) -> bool {
    if let Some((actual_owner, token)) = pending.get(id) {
        if actual_owner == owner {
            token.cancel();
            return true;
        }
    }
    false
}
#[tokio::main]
async fn main() {
    let (output, mut receiver) = mpsc::unbounded_channel::<Value>();
    let writer = tokio::spawn(async move {
        let mut stdout = tokio::io::stdout();
        while let Some(value) = receiver.recv().await {
            let Ok(mut line) = serde_json::to_vec(&value) else {
                continue;
            };
            line.push(b'\n');
            if stdout.write_all(&line).await.is_err() || stdout.flush().await.is_err() {
                break;
            }
        }
    });
    let shared = Arc::new(Mutex::new(State {
        adapter: None,
        owners: HashMap::new(),
        known: HashMap::new(),
        closed: HashSet::new(),
        output: output.clone(),
    }));
    let (requests, mut queue) = mpsc::unbounded_channel::<(Request, CancellationToken)>();
    let pending = Arc::new(Mutex::new(PendingOperations::new()));
    let pending_processor = pending.clone();
    let state = shared.clone();
    let processor = tokio::spawn(async move {
        while let Some((request, cancel)) = queue.recv().await {
            let mut guard = state.lock().await;
            // Cleanup must finish before another owner can acquire a device or
            // restart scanning. close() itself has a bounded cleanup interval.
            let result =
                if request.method == "__closeOwner" || request.method == "closeBluetoothAdapter" {
                    guard.invoke(&request, state.clone()).await
                } else {
                    await_operation(
                        &cancel,
                        Duration::from_millis(request.timeout_ms.clamp(1, 310000)),
                        guard.invoke(&request, state.clone()),
                    )
                    .await
                };
            // A cancelled connect may already have reached the OS. Release its
            // reservation and disconnect before another owner can acquire it.
            if request.method == "createBLEConnection" && matches!(&result, Err((10006 | 10012, _)))
            {
                let id = field(&request.params, "deviceId");
                if let Some(o) = guard.owners.get_mut(&request.owner) {
                    o.connections.remove(id);
                    if let Some(task) = o.notifications.remove(id) {
                        task.abort();
                    }
                }
                if let Some(device) = guard.known.get(id).cloned() {
                    let _ = tokio::time::timeout(Duration::from_secs(5), device.disconnect()).await;
                }
            }
            pending_processor.lock().await.remove(&request.id);
            let value = match result {
                Ok(value) => json!({"id":request.id,"value":value}),
                Err((code, message)) => json!({"id":request.id,"error":message,"errCode":code}),
            };
            let _ = guard.output.send(value);
        }
        let mut s = state.lock().await;
        let owners: Vec<_> = s.owners.keys().cloned().collect();
        for owner in owners {
            s.close(&owner).await;
        }
    });
    let mut owners = HashMap::<String, CancellationToken>::new();
    let mut lines = BufReader::new(tokio::io::stdin()).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        if line.len() > 2 << 20 {
            continue;
        }
        let Ok(request) = serde_json::from_str::<Request>(&line) else {
            continue;
        };
        if request.method == "__cancelRequest" {
            cancel_operation(
                &*pending.lock().await,
                &request.owner,
                field(&request.params, "requestId"),
            );
            continue;
        }
        let cancel =
            if request.method == "__closeOwner" || request.method == "closeBluetoothAdapter" {
                if let Some(token) = owners.remove(&request.owner) {
                    token.cancel();
                }
                CancellationToken::new()
            } else {
                owners
                    .entry(request.owner.clone())
                    .or_default()
                    .child_token()
            };
        pending
            .lock()
            .await
            .insert(request.id.clone(), (request.owner.clone(), cancel.clone()));
        let _ = requests.send((request, cancel));
    }
    for (_, token) in owners {
        token.cancel();
    }
    drop(requests);
    let _ = processor.await;
    drop(shared);
    drop(output);
    writer.abort();
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn cancellation_releases_the_executor_and_cannot_cancel_another_owner() {
        let token = CancellationToken::new();
        let pending = PendingOperations::from([("call".into(), ("first".into(), token.clone()))]);
        assert!(!cancel_operation(&pending, "other", "call"));
        assert!(!token.is_cancelled());
        assert!(cancel_operation(&pending, "first", "call"));
        let result = await_operation(
            &token,
            Duration::from_secs(20),
            std::future::pending::<Result<Value>>(),
        )
        .await;
        assert_eq!(result.unwrap_err().0, 10006);
        let next = await_operation(&CancellationToken::new(), Duration::from_secs(20), async {
            Ok(json!({"available":true}))
        })
        .await
        .unwrap();
        assert_eq!(next, json!({"available":true}));
    }

    #[tokio::test(start_paused = true)]
    async fn operation_deadline_releases_the_shared_executor() {
        let cancel = CancellationToken::new();
        let task = tokio::spawn(async move {
            let result = await_operation(
                &cancel,
                Duration::from_millis(50),
                std::future::pending::<Result<Value>>(),
            )
            .await;
            assert_eq!(result.unwrap_err().0, 10012);
            "next request can run"
        });
        tokio::task::yield_now().await;
        tokio::time::advance(Duration::from_millis(51)).await;
        tokio::task::yield_now().await;
        assert!(
            task.is_finished(),
            "expired BLE operation still owns the shared executor"
        );
        assert_eq!(task.await.unwrap(), "next request can run");
    }

    #[test]
    fn notifications_preserve_service_identity_for_duplicate_characteristic_uuids() {
        let first = Uuid::from_u128(1);
        let second = Uuid::from_u128(2);
        let id = Uuid::from_u128(3);
        let characteristics = BTreeSet::from([
            Characteristic {
                uuid: id,
                service_uuid: first,
                properties: CharPropFlags::NOTIFY,
                descriptors: BTreeSet::new(),
            },
            Characteristic {
                uuid: id,
                service_uuid: second,
                properties: CharPropFlags::NOTIFY,
                descriptors: BTreeSet::new(),
            },
        ]);
        let n = ValueNotification {
            uuid: id,
            service_uuid: second,
            value: vec![0, 255, 1],
        };
        let value = notification_value("device", &characteristics, &n).unwrap();
        assert_eq!(value["serviceId"], json!(second.to_string().to_uppercase()));
        assert_eq!(value["value"], binary(&[0, 255, 1]));
    }

    #[tokio::test]
    async fn powered_off_adapter_reports_unavailable_without_stale_discovery() {
        let (output, mut events) = mpsc::unbounded_channel();
        let mut owners = HashMap::new();
        owners.insert(
            "window".to_owned(),
            Owner {
                scanning: true,
                ..Owner::default()
            },
        );
        let state = Arc::new(Mutex::new(State {
            adapter: None,
            owners,
            known: HashMap::new(),
            closed: HashSet::new(),
            output,
        }));
        handle_event(
            state.clone(),
            CentralEvent::StateUpdate(CentralState::PoweredOff),
        )
        .await;
        let event = events.recv().await.unwrap();
        assert_eq!(
            event["value"],
            json!({"available":false,"discovering":false})
        );
        let request = Request {
            id: "state".into(),
            owner: "window".into(),
            method: "getBluetoothAdapterState".into(),
            params: json!({}),
            timeout_ms: default_operation_timeout(),
        };
        let value = state
            .lock()
            .await
            .invoke(&request, state.clone())
            .await
            .unwrap();
        assert_eq!(value, json!({"available":false,"discovering":false}));
        assert!(!state.lock().await.owners["window"].scanning);
    }
}
