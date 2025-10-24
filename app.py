from flask import Flask, Response, jsonify, request, session, make_response, send_from_directory
from flask_cors import CORS
from flask_session import Session
import networkx as nx
from networkx.readwrite import json_graph
import json, os, time, random, fitz, logging, sys, io, csv
from copy import deepcopy
import pandas as pd
import numpy as np
from datetime import datetime
from io import BytesIO
from collections import defaultdict

# Used for waitress deploy
# logging.basicConfig(
#     filename='JBAM_logs.log',
#     filemode='a',
#     format='%(message)s',
#     level=logging.INFO
# )

log_formatter = logging.Formatter("%(asctime)s [%(levelname)s] %(message)s", "%Y-%m-%d %H:%M:%S")

console_handler = logging.StreamHandler(sys.stdout)
console_handler.setFormatter(log_formatter)

file_handler = logging.FileHandler("JBAM_logs.log", mode="a")
file_handler.setFormatter(log_formatter)

logging.basicConfig(level=logging.INFO, handlers=[console_handler, file_handler])
logging.getLogger('werkzeug').setLevel(logging.WARNING)
logger = logging.getLogger(__name__)

app = Flask(
    __name__,
    static_folder="quote_checker_frontend/build",
    static_url_path=""
)
SESSION_DIR = os.environ.get("RAILWAY_VOLUME_PATH", "/data/flask_sessions")
os.makedirs(SESSION_DIR, exist_ok=True)

app.config.update(
    SESSION_TYPE="filesystem",
    SESSION_FILE_DIR=SESSION_DIR,
    SESSION_PERMANENT=True,
    PERMANENT_SESSION_LIFETIME=60 * 60 * 24 * 30,  # 30 days
    SESSION_COOKIE_SAMESITE="Lax",
    SESSION_COOKIE_SECURE=False,
)
app.config['PASSWORD'] = 'happy'
app.secret_key = '2' # update if cookies are stale

@app.route("/api/login", methods=["POST"])
def login():
    data = request.get_json()
    if data and data.get("password") == app.config["PASSWORD"]:
        session["authenticated"] = True
        session["login_time"] = datetime.utcnow()
        logger.info(f"[LOGIN] User session {session.sid[-6:]} logged in")
        return jsonify({"status": "Logged in"})
    else:
        return jsonify({"error": "Invalid password"}), 401

@app.route("/api/logout", methods=["POST"])
def logout():
    if session.get("authenticated"):
        logout_time = datetime.utcnow()
        login_time = session.get("login_time", logout_time)
        session_duration = (logout_time - login_time).total_seconds() / 60
        logger.info(
            f"[LOGOUT] Session {session.sid[-6:]} logged out. "
            f"Session length: {session_duration:.1f} minutes."
        )
        return jsonify({"status": "Logged out"})
    return jsonify({"error": "Not logged in"}), 401

# Protect API endpoints
@app.before_request
def require_auth():
    # Allow login and static file routes (adjust if necessary)
    if request.path == '/api/login' or request.path.startswith('/static'):
        return
    if request.path.startswith('/api/'):
        if not session.get('authenticated'):
            return jsonify({"error": "Not authorized"}), 401

CORS(app, supports_credentials=True, resources={r"/api/*": {"origins": ["http://localhost:3000", "https://publicationexplorer.com","https://jbam.up.railway.app/"]}})
Session(app)
G = nx.DiGraph()
part_db = []
system_tags = []
PREBUILT_FILE = 'prebuilds.xlsx'

# A tiny Union–Find (Disjoint‐Set) for part‐UIDs:
class UnionFind:
    def __init__(self):
        self.parent = {}
        self.rank = {}

    def make_set(self, x):
        if x not in self.parent:
            self.parent[x] = x
            self.rank[x] = 0

    def find(self, x):
        # path compression
        if self.parent[x] != x:
            self.parent[x] = self.find(self.parent[x])
        return self.parent[x]

    def union(self, x, y):
        rootx = self.find(x)
        rooty = self.find(y)
        if rootx == rooty:
            return False
        # union by rank
        if self.rank[rootx] < self.rank[rooty]:
            self.parent[rootx] = rooty
        elif self.rank[rootx] > self.rank[rooty]:
            self.parent[rooty] = rootx
        else:
            self.parent[rooty] = rootx
            self.rank[rootx] += 1
        return True

def find(lst, key, value):
    for i, dic in enumerate(lst):
        if dic[key] == str(value):
            return i
    return -1

def share_element(A,B):
    return bool(set(A) & set(B))

def unique_ones(matrix):
    row_count = np.sum(matrix, axis=1, keepdims=True)
    col_count = np.sum(matrix, axis=0, keepdims=True)
    mask = (matrix == 1) & ((row_count == 1) | (col_count == 1))
    return mask.astype(int)

def build_partdb(file):
    global part_db, system_tags
    sheets = pd.ExcelFile(file).sheet_names
    df = pd.DataFrame()
    # Iterate through sheets and merge into df
    for sheet in sheets:
        df = pd.concat([df, pd.read_excel(file, sheet_name=sheet)])

    # Any item without a name is removed
    df = df.dropna(subset='Description')
    df.reset_index(drop=True, inplace=True)

    sf_db = pd.read_excel('productDB.xlsx')  # Salesforce export
    sf_codes = sf_db['Product Code'].astype(str).unique()
    sf_lookup = dict(
        zip(sf_db['Product Code'].astype(str), sf_db['Product2ID'].astype(str))
    )

    # Filter JBAMdb based on Salesforce active products
    df = df[df['Product Code'].astype(str).isin(sf_codes) | df['Product Code'].astype(str).str.startswith('JBAM-')]
    # Just for tracking
    empty_parts, defined_parts = 0,0
    for _, row in df.iterrows():
        part_id = str(row['Product Code'])
        part_name = row['Description']
        part_tags = row['Tags'].strip().split(',') if 'Tags' in df.columns and not pd.isna(row['Tags']) else []
        part_alias = None
        add_part = []
        slot_list = []
        for j in range(1, 31):
            rowname = 'slot' + str(j)
            if rowname in df.columns and not pd.isna(row[rowname]):
                if row[rowname].startswith('Alias'):
                    part_alias = row[rowname].split(':')[-1]
                    continue
                elif row[rowname].startswith('AddPart'):
                    add_part.append(row[rowname].split(':')[-1])
                    continue
                else:
                    # Uncomment below to debug failed partdb load
                    #print(row[rowname])
                    slot_fields = row[rowname].split(':')
                    slot_name = slot_fields[0]
                    slot_min = int(slot_fields[1])
                    slot_max = int(slot_fields[2])
                    slot_type = 'Host' if slot_fields[-1] == 'H' else 'Plug'
                    slot_list.append({
                        'Name': slot_name,
                        'Min': slot_min,
                        'Max': slot_max,
                        'Type': slot_type
                    })

        part_db.append({
            'Name': part_name,
            'ID': part_id,
            'Slots': slot_list,
            'Alias': part_alias,
            'AddPart': ','.join(add_part),
            'Tags': part_tags,
            'SalesforceID': sf_lookup.get(part_id, None),
        })
        if not slot_list and not part_alias and part_name:
            empty_parts += 1
        else:
            defined_parts += 1

    # Resolve aliases
    for part in part_db:
        if part['Alias']:
            alias_part = next((d for d in part_db if d['ID'] == part['Alias']), None)
            if alias_part:
                part['Slots'] = part['Slots'] + alias_part['Slots']
                part['AddPart'] = alias_part['AddPart']
            part['Alias'] = None

    # System tags
    print('Defined parts: {}, undefined parts: {}'.format(str(defined_parts),str(empty_parts)))
    system_tags = pd.read_excel('SystemTags.xlsx')

def extract_from_pdf(pdf_input):
    """
    Parse uploaded quote files.
    Supports: PDF and CSV (Excel removed).
    CSV must contain columns: Item ID, Description, Quantity
    """

    ext = os.path.splitext(pdf_input.filename.lower())[1]

    # === CSV PARSE ===
    if ext == ".csv":
        pdf_input.seek(0)

        # Infer delimiter (comma, tab, etc.)
        # engine='python' with sep=None lets pandas sniff the delimiter
        df = pd.read_csv(pdf_input, sep=None, engine="python")

        # Normalize column names (strip spaces) then require the exact three
        df.columns = [str(c).strip() for c in df.columns]
        expected = {"Item ID", "Description", "Quantity"}
        if not expected.issubset(set(df.columns)):
            raise ValueError("CSV must contain columns: Item ID, Description, Quantity")

        # Clean and coerce
        df = df.dropna(subset=["Item ID"])
        # Default quantity to 1 when missing/blank
        df["Quantity"] = (
            df["Quantity"]
            .apply(lambda x: 1 if (pd.isna(x) or str(x).strip() == "") else x)
            .astype(int)
        )

        parsed_items = []
        for _, row in df.iterrows():
            item_id = str(row["Item ID"]).strip()
            desc = str(row["Description"])
            qty = int(row["Quantity"])
            for _ in range(qty):
                uid = session["next_uid"]
                session["next_uid"] += 1
                session["active_status"][uid] = True
                parsed_items.append({
                    "ID": item_id,
                    "Description": desc,
                    "active": True,
                    "uid": uid
                })
        return parsed_items

    # === PDF PARSE === (unchanged)
    data = []
    if isinstance(pdf_input, str):
        with open(pdf_input, "rb") as f:
            file_bytes = f.read()
    else:
        pdf_input.seek(0)
        file_bytes = pdf_input.read()

    try:
        logger.info(
            f"[PDF_LOAD] Session {session.sid[-6:]} loaded PDF '{pdf_input.filename}' "
            f"at {datetime.utcnow().isoformat(timespec='seconds')}"
        )
    except Exception:
        pass

    doc = fitz.open(stream=file_bytes, filetype="pdf")
    for page in doc:
        startflag = False
        text_blocks = page.get_text_blocks()
        for block in text_blocks:
            text = block[4]
            if "E&I Cooperative Agreement" in text:
                break

            if startflag:
                if "SUBTOTAL" not in str(block[0]):
                    tmp = text.split("\n")
                    tmp = [x for x in tmp if x.strip() != "*"]
                    if tmp and tmp[0].isnumeric():
                        data.append(tmp)

            if "QTY\nPRODUCT #" in text:
                startflag = True

    df = pd.DataFrame({
        "QTY": [int(x[0]) for x in data],
        "Item_Num": [x[1] for x in data],
        "Description": [x[2] for x in data],
    })

    # Add a MISC node
    df = pd.concat([
        df,
        pd.DataFrame({
            "QTY": [1],
            "Item_Num": ["MISC"],
            "Description": ["N/A"]
        })
    ], ignore_index=True)

    parsed_items = []
    for _, row in df.iterrows():
        for _ in range(int(row["QTY"])):
            uid = session["next_uid"]
            session["next_uid"] += 1
            session["active_status"][uid] = True
            parsed_items.append({
                "ID": str(row["Item_Num"]),
                "Description": str(row["Description"]),
                "active": True,
                "uid": uid
            })
    return parsed_items

def check_slots():
    empty_slots = 0
    open_slot_nodes = []
    available_slot_nodes = []
    verbose_error = []
    for part in session['quote_network']:
        part_error = ''
        for slot in part['Slots']:
            if len(slot['Status']) < int(slot['Min']):
                if not part_error:
                    part_error += part['Name'] + ' is missing '
                empty_slots += 1
                open_slot_nodes.append(part['Name'])
                part_error += slot['Name'] + ' '
            if len(slot['Status']) < int(slot['Max']):
                available_slot_nodes.append(part['Name'])
        if part_error:
            verbose_error.append(part_error)
    return empty_slots, list(set(open_slot_nodes)), list(set(available_slot_nodes)), verbose_error

def process_addpart(item, parent_uid):
    if not item.get('AddPart'):
        return

    ghost_ids = item['AddPart'].split(',')
    for idx, ghost_id in enumerate(ghost_ids):
        ghost_uid = f"ghost-{parent_uid}-{idx}"
        # Deep-copy the part from the part database.
        tmp_part = find(part_db, 'ID', ghost_id)
        if tmp_part != -1:
            ghost_part = deepcopy(part_db[tmp_part])
        else:
            ghost_part = {'ID': ghost_id,
                'Name': ghost_id +' - NOT IN DB',
                'Slots': [],
                'Alias': None,
                'AddPart': None,
                'Tags': []}
            print('Missing Part:' + ghost_id)
        # Update name and add ghost properties.
        ghost_part['Name'] += " " + str(len(session['quote_network']))
        ghost_part['GhostPart'] = True
        ghost_part['uid'] = ghost_uid

        # Ensure active status is set.
        if ghost_uid not in session['active_status']:
            session['active_status'][ghost_uid] = True
        ghost_part['active'] = session['active_status'][ghost_uid]

        # Add the ghost part to the network.
        session['quote_network'].append(ghost_part)

        # Recursively process any AddPart for this ghost part.
        process_addpart(ghost_part, ghost_uid)

from itertools import combinations

def update_graph():
    global part_db,system_tags
    session['quote_network'] = []
    session['warnings_list'] = []
    session['graph'] = []
    G.clear()

    # Skip all parts with this tag in initial connection pass
    exclude_tags = ['Interlock','LaserSafety','NiLayer','Triggering','BNC']
    # Need to check each of these for total connection
    check_tags = ['LaserSafety','NiLayer','Triggering']

    # Custom arrows for visualization
    custom_arrows = {'InterlockPhone':'InterlockPhone.svg','InterlockRound':'InterlockRound.svg','InterlockPhoneLSC':'InterlockPhone.svg','InterlockRoundLSC':'InterlockRound.svg','InterlockPlug':'InterlockPlug.svg','InterlockLUNF':'InterlockLUNF.svg','BNC':'BNC.svg','BNCBB':'BNC.svg'}
    
    # Assign each line item a unique id
    for line_item in session['quote_list']:
        if "uid" not in line_item:
            line_item["uid"] = session['next_uid']
            session['next_uid'] += 1
            session['active_status'][line_item["uid"]] = True
        # Build out the base part
        loc = find(part_db, "ID", line_item["ID"])
        if loc != -1:
            tmp_item = deepcopy(part_db[loc])
            line_item['Description'] = tmp_item['Name']
        else:
            tmp_item = {
                'ID': line_item["ID"],
                'Name': line_item['Description'],
                'Slots': [],
                'Alias': None,
                'AddPart': None,
                'Tags': []
            }

        # Make unique name so they appear on front end as individual items
        tmp_item['Name'] += " " + str(line_item['uid'])
        tmp_item['GhostPart'] = False
        tmp_item['active'] = session['active_status'].get(line_item["uid"], True)
        tmp_item['uid'] = line_item['uid']

        # Add part to quote network
        session['quote_network'].append(tmp_item)

        # If the part spawns ghost items
        if tmp_item.get('AddPart'):
            process_addpart(tmp_item, line_item['uid'])

    # Custom slots added by user
    if 'custom_slots' in session:
        for custom in session['custom_slots']:
            for part in session['quote_network']:
                if part['ID'] == custom['ID']:
                    slot_parts = custom['slot'].split(':')
                    if len(slot_parts) == 4:
                        slot_name = slot_parts[0]
                        slot_min = int(slot_parts[1])
                        slot_max = int(slot_parts[2])
                        slot_type = 'Host' if slot_parts[3].upper() == 'H' else 'Plug'
                        # Append the custom slot if it does not already exist.
                        if not any(s['Name'].lower() == slot_name.lower() for s in part.get('Slots', [])):
                            part['Slots'].append({
                                'Name': slot_name,
                                'Min': slot_min,
                                'Max': slot_max,
                                'Type': slot_type
                            })
                    break

    # Initialize all slot statuses as empty
    for i in range(len(session['quote_network'])):
        for j in range(len(session['quote_network'][i]['Slots'])):
            session['quote_network'][i]['Slots'][j]['Status'] = []
    
    # Add all nodes to front end graph
    for item in session['quote_network']:
        G.add_node(item["Name"])

    # Transform quote network into slot list
    slot_list = []
    for i,item in enumerate(session['quote_network']):
        slot_list += [{'Index':i,'Name':x['Name'],'GhostPart':item['GhostPart'],'Min':x['Min'],'Max':x['Max'],'Type':x['Type'],'Loc':j} for j,x in enumerate(item['Slots'])]
    n = len(slot_list)

    # Empty matrices. Score, singletons and distance between parts. We connect singletons, then by decreasing score then by increasing distance.
    conn_score = np.zeros((n, n))
    singletons = np.zeros((n, n))
    conn_distance = np.zeros((n, n))

    # Determine scores, singletons and distances
    for i in range(n):
        for j in range(i + 1, n):
            # Skip shared tags between slots
            if set(session['quote_network'][slot_list[i]['Index']]['Tags']).intersection(set(exclude_tags)).intersection(set(session['quote_network'][slot_list[j]['Index']]['Tags']).intersection(set(exclude_tags))):
                continue
            # Skip LaserSafety and Interlock tagged slots (when BOTH slots have either of these tags)
            if set(['Interlock','LaserSafety']).intersection(session['quote_network'][slot_list[i]['Index']]['Tags']) and set(['Interlock','LaserSafety']).intersection(session['quote_network'][slot_list[j]['Index']]['Tags']):
                continue
            # Skip BNC and Triggering tagged slots (when BOTH slots have either of these tags)
            if set(['BNC','Triggering']).intersection(session['quote_network'][slot_list[i]['Index']]['Tags']) and set(['BNC','Triggering']).intersection(session['quote_network'][slot_list[j]['Index']]['Tags']):
                continue
            if slot_list[i]['Index'] != slot_list[j]['Index']:
                conn_score[i][j] = 1
                # Check 1: submin on either slot
                if slot_list[i]['Min'] > 0 and slot_list[j]['Min'] > 0:
                    conn_score[i][j] += 6
                elif slot_list[i]['Min'] > 0 or slot_list[j]['Min'] > 0:
                    conn_score[i][j] += 3
                # Check 2: ghost part
                if slot_list[i]['GhostPart'] == False and slot_list[j]['GhostPart'] == False:
                    conn_score[i][j] += 2
                elif slot_list[i]['GhostPart'] == False or slot_list[j]['GhostPart'] == False:
                    conn_score[i][j] += 1
                    
                if set(slot_list[i]["Name"].split('|')).intersection(set(slot_list[j]["Name"].split('|'))) and slot_list[i]['Type'] != slot_list[j]['Type']:
                    singletons[i][j] = 1
                conn_distance[i][j] = abs(slot_list[i]['Index']-slot_list[j]['Index'])

    # Adding 10 points here is sufficient to make singletons the first to connect
    conn_score = conn_score + unique_ones(singletons) * 10

    # Form slot pairs based on priority
    indices = np.indices(conn_score.shape).reshape(2, -1).T
    filtered_indices = [idx for idx in indices if conn_score[idx[0], idx[1]] > 0]
    sorted_indices = sorted(filtered_indices, key=lambda idx: (-conn_score[idx[0], idx[1]], conn_distance[idx[0], idx[1]]))
    sorted_list = [list(idx) for idx in sorted_indices]
    
    # Pass 1: connect all parts without tags indicated by exclude_tags
    for pair in sorted_list:
        slot1 = session['quote_network'][slot_list[pair[0]]['Index']]['Slots'][slot_list[pair[0]]['Loc']]
        slot2 = session['quote_network'][slot_list[pair[1]]['Index']]['Slots'][slot_list[pair[1]]['Loc']]
        part1 = session['quote_network'][slot_list[pair[0]]['Index']]
        part2 = session['quote_network'][slot_list[pair[1]]['Index']]

        # Ensure we don't create a repeated connection
        part1uid = [item for sublist in [x['Status'] for x in part1['Slots']] for item in sublist]
        part2uid = [item for sublist in [x['Status'] for x in part2['Slots']] for item in sublist]
        if part1['uid'] in part2uid or part2['uid'] in part1uid:
            continue

        if set(slot1["Name"].split('|')).intersection(set(slot2["Name"].split('|'))) and slot1['Type'] != slot2['Type'] and len(slot1['Status']) < int(slot1['Max']) and len(slot2['Status']) < int(slot2['Max']) and part1['active'] and part2['active']:
            # This is a directed graph, so we always connect from Host to Plug
            if slot1['Type'] == 'Host':
                G.add_edge(part1["Name"], part2["Name"], fromSlot=slot1["Name"], toSlot=slot2["Name"])
            else:
                G.add_edge(part2["Name"], part1["Name"], fromSlot=slot2["Name"], toSlot=slot1["Name"])
            
            # Add part uid to status
            slot1["Status"].append(part2['uid'])
            slot2["Status"].append(part1['uid'])

        # Pass 2: Try permutations to validate networks formed by check_tags
    for tag in check_tags:
        interlock_pairs = []

        # Filter parts relevant to this tag
        tag_set = {'LaserSafety', 'Interlock'} if tag == "LaserSafety" else {'Triggering', 'BNC'} if tag == "Triggering" else {tag}
        interlock_parts = [x for x in session['quote_network'] if set(x['Tags']).intersection(tag_set)]

        # Precompute slot indices and tags for each slot
        slot_info = [
            (
                i,
                slot_list[i],
                session['quote_network'][slot_list[i]['Index']],
                set(session['quote_network'][slot_list[i]['Index']]['Tags']),
                set(slot_list[i]['Name'].split('|'))
            )
            for i in range(n)
        ]

        for i in range(n):
            idx1, slot1, part1, tags1, names1 = slot_info[i]
            for j in range(i + 1, n):
                idx2, slot2, part2, tags2, names2 = slot_info[j]
                if part1 is not part2 and names1.intersection(names2):
                    if tag == 'LaserSafety':
                        if {'LaserSafety', 'Interlock'}.intersection(tags1) and {'LaserSafety', 'Interlock'}.intersection(tags2):
                            interlock_pairs.append([i, j])
                    elif tag == 'Triggering':
                        if {'Triggering', 'BNC'}.intersection(tags1) and {'Triggering', 'BNC'}.intersection(tags2):
                            interlock_pairs.append([i, j])
                    elif tag in tags1 and tag in tags2:
                        interlock_pairs.append([i, j])

        best_perm = interlock_pairs
        perms = 1000

        interlock_graph = nx.Graph()
        i_nodes = set()

        for part in interlock_parts:
            node_name = 'I_' + part['Name'] if tag in part['Tags'] else part['Name']
            interlock_graph.add_node(node_name)
            if node_name.startswith('I_'):
                i_nodes.add(node_name)

        i_nodes = list(i_nodes)
        valid_network = False

        quote_network_base = deepcopy(session['quote_network'])  # base copy once, reuse
        for _ in range(perms):
            random.shuffle(interlock_pairs)
            interlock_graph.remove_edges_from(list(interlock_graph.edges))
            quote_network_tmp = deepcopy(quote_network_base)

            for pair in interlock_pairs:
                s1, s2 = slot_list[pair[0]], slot_list[pair[1]]
                part1 = quote_network_tmp[s1['Index']]
                part2 = quote_network_tmp[s2['Index']]
                slot1 = part1['Slots'][s1['Loc']]
                slot2 = part2['Slots'][s2['Loc']]

                uid1 = part1['uid']
                uid2 = part2['uid']
                uids1 = part1['Slots']
                uids2 = part2['Slots']

                if uid1 in [u for slot in uids2 for u in slot['Status']] or uid2 in [u for slot in uids1 for u in slot['Status']]:
                    continue

                if slot1['Type'] != slot2['Type'] and len(slot1['Status']) < int(slot1['Max']) and len(slot2['Status']) < int(slot2['Max']) and part1['active'] and part2['active']:
                    slot1["Status"].append(uid2)
                    slot2["Status"].append(uid1)
                    n1 = part1["Name"] if part1["Name"] in interlock_graph else 'I_' + part1["Name"]
                    n2 = part2["Name"] if part2["Name"] in interlock_graph else 'I_' + part2["Name"]
                    interlock_graph.add_edge(n1, n2)

            if len(i_nodes) > 1:
                connected = nx.node_connected_component(interlock_graph, i_nodes[0])
                if all(n in connected for n in i_nodes):
                    valid_network = True
                    best_perm = interlock_pairs[:]
                    break
            else:
                valid_network = True
                break

        if not valid_network:
            session['warnings_list'].append(f'{tag} not valid')

        # Final connection using best_perm
        for pair in best_perm:
            s1, s2 = slot_list[pair[0]], slot_list[pair[1]]
            part1 = session['quote_network'][s1['Index']]
            part2 = session['quote_network'][s2['Index']]
            slot1 = part1['Slots'][s1['Loc']]
            slot2 = part2['Slots'][s2['Loc']]

            uid1 = part1['uid']
            uid2 = part2['uid']
            uids1 = part1['Slots']
            uids2 = part2['Slots']

            if uid1 in [u for slot in uids2 for u in slot['Status']] or uid2 in [u for slot in uids1 for u in slot['Status']]:
                continue

            if tag not in part1['Tags'] and tag not in part2['Tags']:
                if tag == 'LaserSafety' and 'Interlock' in part1['Tags'] and 'Interlock' in part2['Tags']:
                    pass
                else:
                    continue

            if slot1['Type'] != slot2['Type'] and len(slot1['Status']) < int(slot1['Max']) and len(slot2['Status']) < int(slot2['Max']) and part1['active'] and part2['active']:
                if slot1['Type'] == 'Host':
                    slot1, slot2 = slot2, slot1
                    part1, part2 = part2, part1

                if slot1['Name'] in custom_arrows:
                    G.add_edge(part2["Name"], part1["Name"], arrows={
                        "from": {
                            "enabled": True,
                            "type": "image",
                            "src": f"/images/{custom_arrows[slot1['Name']]}",
                            "scaleFactor": 1,
                            "imageWidth": 40,
                            "imageHeight": 40
                        },
                        "to": {"enabled": False},
                    }, arrowStrikethrough=False,
                    fromSlot=slot1["Name"],
                    toSlot=slot2["Name"])
                else:
                    G.add_edge(part2["Name"], part1["Name"],fromSlot=slot1["Name"],toSlot=slot2["Name"])

                slot1["Status"].append(part2['uid'])
                slot2["Status"].append(part1['uid'])

    # System tag checks
    active_parts = [x for x in session['quote_network'] if x['active']]
    active_tags = [tag for p in active_parts for tag in p['Tags']]
    for _, row in system_tags.iterrows():
        if row['Type'] == 'Require':
            if all(any(cond.strip() in x['Tags'] for x in active_parts) for cond in row['Condition1'].split(',')) and row['Condition2'] not in active_tags:
                session['warnings_list'].append(row['Warning'])
        elif row['Type'] == 'Exclude':
            if any(row['Condition1'] in x['Tags'] for x in active_parts) and row['Condition2'] in active_tags:
                session['warnings_list'].append(row['Warning'])

    # Final graph export
    session['graph'] = json_graph.node_link_data(G)
    for u, v, edge_data in G.edges(data=True):
        for link in session['graph']["links"]:
            if link["source"] == u and link["target"] == v:
                link.update(edge_data)
                break


def graph_to_json():
    """
    Build the merged graph + a sidebar-friendly items list that nests ghosts
    under their user-added parent(s) with no duplicate top-level rows.
    Includes slot occupancy counts.
    """
    from collections import defaultdict

    name_to_data = {nd["Name"]: nd for nd in session["quote_network"]}
    adjacency_map = {}
    for u, v in G.edges():
        adjacency_map.setdefault(u, set()).add(v)
        adjacency_map.setdefault(v, set()).add(u)

    # === Compute slot usage counts ===
    slot_usage = defaultdict(int)
    for edge in G.edges(data=True):
        src = edge[0]
        tgt = edge[1]
        src_slot = edge[2].get("fromSlot")
        tgt_slot = edge[2].get("toSlot")
        if src_slot:
            slot_usage[(src, src_slot)] += 1
        if tgt_slot:
            slot_usage[(tgt, tgt_slot)] += 1

    # === Merge nodes ===
    merge_dict = {}
    for n in G.nodes():
        nd = name_to_data.get(n, {})
        if not nd:
            continue
        node_name = n
        key = (
            nd.get("ID"),
            nd.get("GhostPart", False),
            nd.get("active", True),
            tuple(sorted(adjacency_map.get(n, []))),
        )
        if key not in merge_dict:
            merge_dict[key] = {"representative_name": node_name, "uids": [], "count": 0}
        merge_dict[key]["count"] += 1
        merge_dict[key]["uids"].append(nd.get("uid"))

    merged_nodes = []
    name_to_rep = {}
    for merge_key, info in merge_dict.items():
        rep_name = info["representative_name"]
        rep_nd = name_to_data[rep_name]
        label_no_index = rep_nd["Name"].rsplit(" ", 1)[0]
        count = info["count"]

        # Enrich slots with Filled counts
        enriched_slots = []
        for s in rep_nd.get("Slots", []):
            slot_name = s.get("Name")
            filled = slot_usage.get((rep_name, slot_name), 0)
            enriched_slots.append({
                "Name": slot_name,
                "Type": s.get("Type"),
                "Min": s.get("Min", 0),
                "Max": s.get("Max", 1),
                "Filled": filled
            })

        merged_nodes.append({
            "id": rep_name,
            "label": label_no_index,
            "badgeCount": count,
            "ghost": rep_nd.get("GhostPart", False),
            "active": rep_nd.get("active", True),
            "uid": info["uids"],
            "tags": rep_nd.get("Tags", []),
            "SalesforceID": rep_nd.get("SalesforceID"),
            "Slots": enriched_slots,
        })

        for n in G.nodes():
            nd = name_to_data.get(n, {})
            if not nd:
                continue
            current_key = (
                nd.get("ID"),
                nd.get("GhostPart", False),
                nd.get("active", True),
                tuple(sorted(adjacency_map.get(n, []))),
            )
            if current_key == merge_key:
                name_to_rep[n] = rep_name

    # === Merge edges ===
    merged_edges = {}
    for u, v, edge_data in G.edges(data=True):
        rep_u = name_to_rep.get(u, u)
        rep_v = name_to_rep.get(v, v)
        if rep_u == rep_v:
            continue
        key = (rep_u, rep_v)
        if key not in merged_edges:
            merged_edges[key] = {"from": rep_u, "to": rep_v}
            if "arrows" in edge_data:
                merged_edges[key]["arrows"] = edge_data["arrows"]
        else:
            if "arrows" in edge_data and "arrows" not in merged_edges[key]:
                merged_edges[key]["arrows"] = edge_data["arrows"]
    merged_edges_list = list(merged_edges.values())

    # === Ghost hierarchy for sidebar ===
    ghosts_by_parent = defaultdict(list)
    for part in session["quote_network"]:
        if part.get("GhostPart"):
            uid = str(part.get("uid", ""))
            if uid.startswith("ghost-"):
                bits = uid.split("-")
                if len(bits) >= 3:
                    parent_uid = bits[1]
                    base_name = part.get("Name", "").rsplit(" ", 1)[0]
                    ghosts_by_parent[parent_uid].append({
                        "id": part.get("ID", ""),
                        "description": base_name,
                    })

    user_counts = {}
    uids_by_id = defaultdict(list)
    for p in session["quote_list"]:
        pid = p["ID"]
        desc = p["Description"]
        uid = str(p.get("uid"))
        if pid not in user_counts:
            user_counts[pid] = {"count": 0, "desc": desc}
        user_counts[pid]["count"] += 1
        uids_by_id[pid].append(uid)

    user_added_ids = set(user_counts.keys())

    merged_items = []
    for pid, info in user_counts.items():
        base_desc = info["desc"]
        final_desc = f"{base_desc} x{info['count']}" if info["count"] > 1 else base_desc
        child_ghosts = []
        for puid in uids_by_id[pid]:
            for g in ghosts_by_parent.get(puid, []):
                if g["id"] in user_added_ids:
                    continue
                child_ghosts.append(g)

        merged_items.append({
            "id": pid,
            "description": final_desc,
            "ghosts": child_ghosts,
        })

    # === Slot checks / status ===
    empty_slots, open_slot_nodes, available_slot_nodes, verbose_error = check_slots()
    verbose_error = "\n".join(verbose_error)
    status_message = verbose_error if empty_slots else "All slots filled."

    return {
        "nodes": merged_nodes,
        "edges": merged_edges_list,
        "items": merged_items,
        "open_slot_nodes": list(set(open_slot_nodes)),
        "available_slot_nodes": list(set(available_slot_nodes)),
        "status_message": status_message,
        "warnings": session["warnings_list"],
    }



@app.before_request
def init_session():
    if 'quote_network' not in session:
        global part_db
        session['quote_network'] = []
        session['warnings_list'] = []
        session['next_uid'] = 1
        session['active_status'] = {}
        session['graph'] = []
        session['quote_list'] = []
        session['custom_slots'] = []
        update_graph()
    session.modified = True
        
@app.route("/api/graph", methods=["GET"])
def get_graph():
    empty_slots, open_slot_nodes, available_slot_nodes, verbose_error = check_slots()
    verbose_error = ('\n').join(verbose_error)
    status_message = f"{verbose_error}" if empty_slots else "All slots filled."
    return jsonify(graph_to_json())

@app.route("/api/add_item", methods=["POST"])
def add_item():
    global part_db
    data = request.get_json()

    # Support both single and multiple items
    items = data.get("items") or [data.get("item")]

    for item_id in items:
        if not item_id:
            continue

        # Find part entry
        part_entry = next((part for part in part_db if part["ID"] == item_id), None)
        desc = part_entry["Name"] if part_entry else "Unknown Part"

        new_item = {
            "ID": item_id,
            "Description": desc,
            "active": True,
            "uid": session['next_uid']
        }

        session['active_status'][session['next_uid']] = True
        session['next_uid'] += 1
        session['quote_list'].append(new_item)
        logger.info(f"[ADD_ITEM] Session {session.sid[-6:]} added part {new_item['ID']}")

    update_graph()
    return jsonify(graph_to_json())

@app.route("/api/remove_item", methods=["POST"])
def remove_item():
    data = request.json
    item_to_remove = data.get("item")
    found = False
    new_quote_list = []
    for item in session['quote_list']:
        if item["ID"] == item_to_remove and not found:
            desc = item['Description']
            found = True
            continue
        new_quote_list.append(item)
    session['quote_list'] = new_quote_list
    logger.info(f"[REMOVE_ITEM] Session {session.sid[-6:]} removed part {item_to_remove}")
    session.modified = True
    update_graph()
    return jsonify(graph_to_json())

@app.route("/api/parts")
def get_all_parts():
    global part_db
    available_parts = [{"id": part["ID"], "description": part["Name"]} for part in part_db]
    return jsonify(available_parts)

@app.route("/api/load_pdf", methods=["POST"])
def load_pdf():
    if "file" not in request.files:
        return jsonify({"error": "No file uploaded"}), 400
    file = request.files["file"]
    if file.filename == "":
        return jsonify({"error": "No selected file"}), 400
    session['quote_list'] = extract_from_pdf(file)
    update_graph()
    return jsonify(graph_to_json())

@app.route("/api/clear", methods=["POST"])
def clear_quote():
    try:
        session['quote_network'] = []
        session['warnings_list'] = []
        session['next_uid'] = 1
        session['active_status'] = {}
        session['quote_list'] = []
        session['graph'] = []
        session.modified = True
        update_graph()
        return jsonify(graph_to_json())
    except Exception as e:
        return jsonify({"error": "Failed to clear quote", "message": str(e)}), 500

@app.route("/api/save", methods=["POST"])
def save_partdb_simple():
    """
    Export the current part_db with only Item ID, Description, and Quantity columns.
    """

    # Get the current part list
    quote_items = session.get("quote_list", [])
    if not quote_items:
        return jsonify({"error": "No items found in session"}), 400

    # Count quantities by item ID
    quantities = {}
    for item in quote_items:
        item_id = item.get("id") or item.get("ID")
        if item_id:
            quantities[item_id] = quantities.get(item_id, 0) + 1

    # Create CSV in memory
    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow(["Item ID", "Description", "Quantity"])

    for item_id, qty in quantities.items():
        # find one example to grab the description
        desc = next(
            (i.get("Description") or "") for i in quote_items if (i.get("id") or i.get("ID")) == item_id
        )
        if item_id == "MISC" and desc == "MISC":
            continue
        writer.writerow([item_id, desc, qty])

    # Return downloadable CSV
    return Response(
        output.getvalue(),
        mimetype="text/csv",
        headers={"Content-Disposition": "attachment; filename=part_list.csv"}
    )


@app.route("/api/suggest_parts", methods=["POST"])
def suggest_parts():
    global part_db
    data = request.json
    node_name = data.get("node_name")
    suggestion_type = data.get("suggestion_type", "all parts")
    node_item = next((x for x in session['quote_network'] if x['Name'] == node_name), None)
    if not node_item:
        return jsonify({"suggestions": {}})

    open_slots = []
    for slot in node_item['Slots']:
        if suggestion_type == "all parts":
            if len(slot['Status']) < int(slot['Max']):
                open_slots.append(slot)
        elif suggestion_type == "missing parts":
            if len(slot['Status']) < int(slot['Min']):
                open_slots.append(slot)

    suggestions_by_slot = {}
    for open_slot in open_slots:
        slot_key = open_slot['Name']
        suggestions_by_slot.setdefault(slot_key, set())
        open_slot_names = open_slot['Name'].split('|')
        needed_type = 'Plug' if open_slot['Type'] == 'Host' else 'Host'
        for part in part_db:
            for s in part['Slots']:
                slot_names = s['Name'].split('|')
                if s['Type'] == needed_type and any(x in slot_names for x in open_slot_names):
                    suggestions_by_slot[slot_key].add((part['ID'], part['Name']))

    suggestions_by_slot = {
        k: [{"ID": tup[0], "Name": tup[1]} for tup in suggestions_by_slot[k]]
        for k in suggestions_by_slot
    }

    
    return jsonify({"suggestions": suggestions_by_slot})

@app.route("/api/toggle_item", methods=["POST"])
def toggle_item():
    data = request.json
    uid = data.get("uid")
    new_state = data.get("active")
    if uid is None or new_state is None:
        return jsonify({"error": "Invalid data"}), 400

    if isinstance(uid, list):
        for u in uid:
            session['active_status'][u] = new_state
    else:
        session['active_status'][uid] = new_state
    for i, item in enumerate(session.get('quote_list', [])):
        if str(item.get('uid')) == str(uid[0]):
            moved_item = session['quote_list'].pop(i)
            session['quote_list'].append(moved_item)
            break

    update_graph()
    return jsonify(graph_to_json())

@app.route("/api/connect_custom", methods=["POST"])
def connect_custom():
    data = request.get_json()

    # Extract parameters: source and target node names, and the slot name (e.g., "InterlockLUNF")
    source_node_name = data.get("source")
    target_node_name = data.get("target")
    slot_name = data.get("slot")
    
    if not source_node_name or not target_node_name or not slot_name:
         return jsonify({"error": "Missing parameters", "data": data}), 400

    # Look up nodes by name as in suggest_parts
    source_node = next((x for x in session['quote_network'] if x['Name'] == source_node_name), None)
    target_node = next((x for x in session['quote_network'] if x['Name'] == target_node_name), None)
    if not source_node or not target_node:
         return jsonify({"error": "Could not find source or target node by name"}), 400

    # Extract the actual part IDs
    source_id = source_node.get("ID")
    target_id = target_node.get("ID")

    # Check which node already has a slot with this name
    source_has_slot = any(s['Name'].lower() == slot_name.lower() for s in source_node.get('Slots', []))
    target_has_slot = any(s['Name'].lower() == slot_name.lower() for s in target_node.get('Slots', []))

    if not source_has_slot and not target_has_slot:
         return jsonify({"error": "Neither node has the base slot. Cannot determine complementary type."}), 400

    # Determine base slot type from the node that already has it.
    base_type = None
    if source_has_slot:
         base_slot = next((s for s in source_node.get('Slots', []) if s['Name'].lower() == slot_name.lower()), None)
         if base_slot:
              base_type = base_slot.get("Type")  # Expected to be "Host" or "Plug"
    elif target_has_slot:
         base_slot = next((s for s in target_node.get('Slots', []) if s['Name'].lower() == slot_name.lower()), None)
         if base_slot:
              base_type = base_slot.get("Type")
    
    if not base_type:
         return jsonify({"error": "Base slot type not determined"}), 400

    # Determine complementary type.
    if base_type.lower() == "host":
         complementary_type = "Plug"
         comp_flag = "P"
    elif base_type.lower() == "plug":
         complementary_type = "Host"
         comp_flag = "H"
    else:
         return jsonify({"error": "Unknown base slot type"}), 400

    # The complementary slot will use defaults: min=1 and max=1.
    # Form the custom slot string in the same format as before.
    custom_slot_str = f"{slot_name}:1:1:{comp_flag}"

    # Identify which node is missing the slot.
    missing_node_id = None
    if source_has_slot and not target_has_slot:
         missing_node_id = target_id
    elif target_has_slot and not source_has_slot:
         missing_node_id = source_id
    else:
         # If both nodes already have the slot, we don't add anything.
         return jsonify({"error": "Both nodes already have the slot"}), 400

    # Ensure the custom_slots session variable exists.
    if "custom_slots" not in session:
         session["custom_slots"] = []

    # Avoid duplicates: only add if not already present.
    if not any(cs["ID"] == missing_node_id and cs["slot"].lower() == custom_slot_str.lower() 
               for cs in session["custom_slots"]):
         session["custom_slots"].append({"ID": missing_node_id, "slot": custom_slot_str})

    # Rebuild the graph so the new custom slot is appended to the part's slot list.
    update_graph()
    return jsonify(graph_to_json())

@app.route("/api/prebuilts", methods=["GET"])
def get_prebuilts():
    """Return only Excel-defined prebuilts (global templates)."""
    prebuilts = []
    try:
        if os.path.exists(PREBUILT_FILE):
            xls = pd.ExcelFile(PREBUILT_FILE)
            prebuilts = xls.sheet_names
    except Exception as e:
        print("Error reading prebuilds:", e)

    return jsonify({"prebuilts": sorted(prebuilts)})


@app.route("/api/load_prebuilt", methods=["POST"])
def load_prebuilt():
    """Load a prebuilt system from either Excel or session storage."""
    data = request.get_json()
    name = data.get("name", "")
    if not name:
        return jsonify({"error": "No name provided"}), 400

    # --- Try Excel first ---
    if os.path.exists(PREBUILT_FILE):
        try:
            xl = pd.ExcelFile(PREBUILT_FILE)
            if name in xl.sheet_names:
                df = pd.read_excel(PREBUILT_FILE, sheet_name=name)
                session["quote_list"] = []
                session["next_uid"] = 0
                session["active_status"] = {}

                for _, row in df.iterrows():
                    part_id = str(row["Product Code"])
                    qty = int(row["Quantity"]) if "Quantity" in row and not pd.isna(row["Quantity"]) else 1

                    # Find description from part_db if missing
                    desc = row.get("Description", "")
                    if not desc or pd.isna(desc):
                        match = next((p["Name"] for p in part_db if p["ID"] == part_id), part_id)
                        desc = match

                    for _ in range(qty):
                        uid = session["next_uid"]
                        session["next_uid"] += 1
                        session["active_status"][uid] = True
                        session["quote_list"].append({
                            "ID": part_id,
                            "Description": desc,
                            "active": True,
                            "uid": uid
                        })

                update_graph()
                return jsonify(graph_to_json())
        except Exception as e:
            print("Excel load failed:", e)

    # --- Fall back to session prebuilts ---
    if "session_prebuilts" in session and name in session["session_prebuilts"]:
        session["quote_list"] = list(session["session_prebuilts"][name])
        session["next_uid"] = 0
        session["active_status"] = {}
        update_graph()
        return jsonify(graph_to_json())

    return jsonify({"error": f"Prebuilt '{name}' not found"}), 404

@app.route("/api/save_prebuilt_session", methods=["POST"])
def save_prebuilt_session():
    """Save the current quote as a session-based prebuilt configuration."""
    data = request.get_json()
    name = data.get("name", "").strip()
    if not name:
        return jsonify({"error": "Name is required"}), 400

    quote = session.get("quote_list", [])
    if not quote:
        return jsonify({"error": "No quote loaded"}), 400

    if "session_prebuilts" not in session:
        session["session_prebuilts"] = {}

    # Save a shallow copy of the quote list
    session["session_prebuilts"][name] = list(quote)
    session.modified = True
    return jsonify({"success": True, "message": f"Saved as '{name}'"})


@app.route("/api/session_prebuilts", methods=["GET"])
def get_session_prebuilts():
    """Return all session-stored prebuilts for this user."""
    prebuilts = list(session.get("session_prebuilts", {}).keys())
    return jsonify({"prebuilts": prebuilts})


@app.route("/api/load_session_prebuilt", methods=["POST"])
def load_session_prebuilt():
    """Load a saved prebuilt from the user's session."""
    data = request.get_json()
    name = data.get("name")
    session_prebuilts = session.get("session_prebuilts", {})
    if not name or name not in session_prebuilts:
        return jsonify({"error": "Prebuilt not found"}), 404

    session["quote_list"] = list(session_prebuilts[name])
    session["next_uid"] = 0
    session["active_status"] = {}
    update_graph()
    return jsonify(graph_to_json())

@app.route("/api/delete_prebuilt_session", methods=["POST"])
def delete_prebuilt_session():
    """Delete a session-based prebuilt by name."""
    data = request.get_json()
    name = data.get("name")
    if not name:
        return jsonify({"error": "No name provided"}), 400

    if "session_prebuilts" not in session or name not in session["session_prebuilts"]:
        return jsonify({"error": f"Template '{name}' not found"}), 404

    del session["session_prebuilts"][name]
    session.modified = True
    return jsonify({"success": True, "message": f"Deleted template '{name}'"})

if __name__ == "__main__":
    # Run only in local dev
    print("Running locally, building partdb...")
    try:
        if os.path.exists("JBAMdb.xlsx"):
            build_partdb("JBAMdb.xlsx")
            print("✅ build_partdb succeeded", flush=True)
        else:
            print("⚠️ JBAMdb.xlsx not found — skipping build_partdb()", flush=True)
    except Exception as e:
        print(f"❌ build_partdb failed: {e}", flush=True)
    port = int(os.environ.get("PORT", 8080))
    app.run(host="0.0.0.0", port=port)

@app.route("/")
def index():
    return send_from_directory(app.static_folder, "index.html")

@app.route("/<path:path>")
def serve_frontend(path):
    # Don't intercept API requests
    if path.startswith("api/"):
        return "API route", 404

    build_dir = app.static_folder
    full_path = os.path.join(build_dir, path)

    if path and os.path.exists(full_path):
        return send_from_directory(build_dir, path)
    else:
        return send_from_directory(build_dir, "index.html")

build_partdb('JBAMdb.xlsx')