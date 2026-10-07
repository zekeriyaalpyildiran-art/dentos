-- S7.1 Lab orders and inventory management

-- Lab order status enum
CREATE TYPE lab_order_status AS ENUM ('draft', 'submitted', 'in_progress', 'ready', 'delivered', 'cancelled');

-- Lab orders table
CREATE TABLE lab_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id uuid NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  patient_id uuid NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  doctor_id uuid NOT NULL REFERENCES doctors(id) ON DELETE CASCADE,
  treatment_plan_id uuid REFERENCES treatment_plans(id) ON DELETE SET NULL,
  order_number text NOT NULL UNIQUE,
  status lab_order_status DEFAULT 'draft',
  due_date date NOT NULL,
  delivery_date date,
  notes text,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

-- Lab order items (specific dental work)
CREATE TABLE lab_order_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id uuid NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  lab_order_id uuid NOT NULL REFERENCES lab_orders(id) ON DELETE CASCADE,
  item_type text NOT NULL, -- 'crown', 'bridge', 'denture', 'implant_crown', etc.
  description text,
  tooth_number text, -- e.g., '16', '11-12-13'
  material text, -- 'zirconium', 'ceramic', 'composite', 'metal'
  color_code text, -- e.g., 'A1', 'A2', 'A3'
  quantity integer DEFAULT 1,
  notes text,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

-- Inventory/Stock table
CREATE TABLE stock_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id uuid NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  item_code text NOT NULL,
  item_name text NOT NULL,
  category text, -- 'materials', 'instruments', 'disposables', 'supplies'
  quantity_on_hand integer NOT NULL DEFAULT 0,
  quantity_minimum integer NOT NULL DEFAULT 5,
  unit_price numeric NOT NULL,
  supplier text,
  last_restocked_at timestamp with time zone,
  expiry_date date,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  UNIQUE(clinic_id, item_code)
);

-- Stock transactions (audit trail)
CREATE TABLE stock_transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id uuid NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  stock_item_id uuid NOT NULL REFERENCES stock_items(id) ON DELETE CASCADE,
  transaction_type text NOT NULL, -- 'purchase', 'usage', 'adjustment', 'damage', 'expiry'
  quantity_change integer NOT NULL,
  reference_id text, -- Lab order ID or appointment ID
  notes text,
  created_by uuid REFERENCES users(id),
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

-- Indexes
CREATE INDEX idx_lab_orders_clinic_id ON lab_orders(clinic_id);
CREATE INDEX idx_lab_orders_patient_id ON lab_orders(patient_id);
CREATE INDEX idx_lab_orders_doctor_id ON lab_orders(doctor_id);
CREATE INDEX idx_lab_orders_status ON lab_orders(status);
CREATE INDEX idx_lab_orders_due_date ON lab_orders(due_date);

CREATE INDEX idx_lab_order_items_clinic_id ON lab_order_items(clinic_id);
CREATE INDEX idx_lab_order_items_lab_order_id ON lab_order_items(lab_order_id);

CREATE INDEX idx_stock_items_clinic_id ON stock_items(clinic_id);
CREATE INDEX idx_stock_items_category ON stock_items(category);
CREATE INDEX idx_stock_items_quantity ON stock_items(quantity_on_hand);

CREATE INDEX idx_stock_transactions_clinic_id ON stock_transactions(clinic_id);
CREATE INDEX idx_stock_transactions_stock_item_id ON stock_transactions(stock_item_id);
CREATE INDEX idx_stock_transactions_type ON stock_transactions(transaction_type);

-- Enable RLS
ALTER TABLE lab_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE lab_order_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_transactions ENABLE ROW LEVEL SECURITY;

-- RLS Policies for lab_orders
CREATE POLICY "lab_orders_clinic_isolation" ON lab_orders FOR SELECT
  USING (clinic_id = (auth.jwt() ->> 'clinic_id')::uuid);

CREATE POLICY "lab_orders_insert_own_clinic" ON lab_orders FOR INSERT
  WITH CHECK (clinic_id = (auth.jwt() ->> 'clinic_id')::uuid);

CREATE POLICY "lab_orders_update_own_clinic" ON lab_orders FOR UPDATE
  USING (clinic_id = (auth.jwt() ->> 'clinic_id')::uuid)
  WITH CHECK (clinic_id = (auth.jwt() ->> 'clinic_id')::uuid);

-- RLS Policies for lab_order_items
CREATE POLICY "lab_order_items_clinic_isolation" ON lab_order_items FOR SELECT
  USING (clinic_id = (auth.jwt() ->> 'clinic_id')::uuid);

CREATE POLICY "lab_order_items_insert_own_clinic" ON lab_order_items FOR INSERT
  WITH CHECK (clinic_id = (auth.jwt() ->> 'clinic_id')::uuid);

-- RLS Policies for stock_items
CREATE POLICY "stock_items_clinic_isolation" ON stock_items FOR SELECT
  USING (clinic_id = (auth.jwt() ->> 'clinic_id')::uuid);

CREATE POLICY "stock_items_insert_own_clinic" ON stock_items FOR INSERT
  WITH CHECK (clinic_id = (auth.jwt() ->> 'clinic_id')::uuid);

CREATE POLICY "stock_items_update_own_clinic" ON stock_items FOR UPDATE
  USING (clinic_id = (auth.jwt() ->> 'clinic_id')::uuid)
  WITH CHECK (clinic_id = (auth.jwt() ->> 'clinic_id')::uuid);

-- RLS Policies for stock_transactions
CREATE POLICY "stock_transactions_clinic_isolation" ON stock_transactions FOR SELECT
  USING (clinic_id = (auth.jwt() ->> 'clinic_id')::uuid);

CREATE POLICY "stock_transactions_insert_own_clinic" ON stock_transactions FOR INSERT
  WITH CHECK (clinic_id = (auth.jwt() ->> 'clinic_id')::uuid);
