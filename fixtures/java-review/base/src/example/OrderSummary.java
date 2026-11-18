package example;

public final class OrderSummary {
  private final OrderService service = new OrderService();

  public int itemCount(String customerId) {
    int count = 0;
    for (String ignored : service.itemIds(customerId)) {
      count++;
    }
    return count;
  }
}
